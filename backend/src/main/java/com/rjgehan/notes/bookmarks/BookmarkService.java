package com.rjgehan.notes.bookmarks;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.BookmarksResponse;
import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.BookmarksChangedEvent;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.core.util.DefaultIndenter;
import tools.jackson.core.util.DefaultPrettyPrinter;
import tools.jackson.core.util.Separators;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Bookmarks (ROADMAP item 12, DESIGN §5.21): {@code .notesapp/bookmarks.json} in Obsidian's {@code bookmarks.json}
 * format, saved with a version token like the settings, committed in the normal batch, announced with
 * {@code bookmarks.changed}, and kept pointing at their targets: a move or rename through the app re-keys them (like
 * links), a trash restore to another path brings them along, and a deleted target leaves its bookmark in place, shown
 * as missing until the target comes back.
 * <p>
 * The file is read from disk on every request (it is small), so a hand edit or a pull is seen at once. A vault without
 * the file shows the bookmarks Obsidian left in {@code .obsidian/bookmarks.json}, which is only ever read; the first
 * change writes NotesApp's own file.
 */
@Service
public class BookmarkService {

	private static final Logger logger = LoggerFactory.getLogger(BookmarkService.class);

	public static final String FILE = ".notesapp/bookmarks.json";

	static final String OBSIDIAN_FILE = ".obsidian/bookmarks.json";

	private static final ApiPath PATH = ApiPath.of(FILE);

	private static final DateTimeFormatter BACKUP_STAMP = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'")
		.withZone(ZoneOffset.UTC);

	private static final int MAX_REASON_ERRORS = 3;

	/**
	 * The bookmarks as stored: {@code root} is the whole document (other top-level fields kept), {@code version} the
	 * blob id of the file's bytes (or of the serialized document when there is no file), {@code broken} when the file
	 * exists but is not a JSON object.
	 */
	private record Document(ObjectNode root, List<ObjectNode> items, String version, boolean onDisk,
			boolean broken) {
	}

	private final VaultFs fs;

	private final VaultIndex index;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final Clock clock;

	private final JsonMapper mapper;

	private final ObjectWriter writer;

	private final ReentrantLock lock = new ReentrantLock();

	public BookmarkService(VaultFs fs, VaultIndex index, CommitBatcher batcher, EventHub hub, Clock clock,
			JsonMapper mapper) {
		this.fs = fs;
		this.index = index;
		this.batcher = batcher;
		this.hub = hub;
		this.clock = clock;
		this.mapper = mapper;
		DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
		DefaultPrettyPrinter printer = new DefaultPrettyPrinter(Separators.createDefaultInstance()
			.withObjectNameValueSpacing(Separators.Spacing.AFTER)
			.withObjectEmptySeparator("")
			.withArrayEmptySeparator("")).withObjectIndenter(indenter).withArrayIndenter(indenter);
		this.writer = mapper.writer().with(printer);
	}

	/** {@code GET /api/bookmarks}. */
	public BookmarksResponse get() throws IOException {
		Document document = read();
		return new BookmarksResponse(document.version(), document.items());
	}

	/**
	 * {@code PUT /api/bookmarks}: validates, then applies the version protocol of API.md §4 against the file on disk.
	 * Equal content is never a conflict.
	 */
	public BookmarksResponse update(@Nullable JsonNode items, @Nullable String baseVersion, Identity identity,
			@Nullable String origin) throws IOException {
		BookmarkCodec.Parsed parsed = BookmarkCodec.read(items);
		List<FieldError> errors = new ArrayList<>(parsed.errors());
		if (baseVersion == null || baseVersion.isBlank()) {
			errors.add(new FieldError("baseVersion", "is required"));
		}
		if (!errors.isEmpty()) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "Invalid bookmarks: " + describe(errors),
					Map.of("errors", errors));
		}
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				Document current = read();
				ObjectNode next = BookmarkCodec.document(current.root(), parsed.items());
				byte[] bytes = serialize(next);
				String version = Hashing.blobId(bytes);
				if (version.equals(current.version())) {
					return new BookmarksResponse(version, parsed.items());
				}
				if (!current.version().equals(baseVersion)) {
					throw conflict(current);
				}
				write(current, bytes, Author.of(identity));
				this.hub.publish(new BookmarksChangedEvent(version, origin));
				logger.info("BOOKMARKS saved items={} client={} user={}", count(parsed.items()), origin,
						identity.login());
				return new BookmarksResponse(version, parsed.items());
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	/**
	 * After a move or rename through the app (the caller holds the vault write lock): bookmarks of the moved file, or
	 * of the folder and anything under it, follow it, as links do. Matching ignores case, like link resolution, unless
	 * another file has the bookmark's exact path. A failure is logged; the move has happened anyway.
	 */
	public void moved(String from, String to, EntryType type, Identity identity) {
		String lowerFrom = PathNames.lower(from);
		rekey((kind, path) -> {
			String lower = PathNames.lower(path);
			if (lower.equals(lowerFrom)) {
				boolean sameKind = (type == EntryType.FILE) == kind.equals(BookmarkCodec.FILE);
				return (sameKind && (path.equals(from) || !exists(path))) ? to : null;
			}
			if (type == EntryType.FOLDER && lower.startsWith(lowerFrom + "/")) {
				return to + "/" + below(path, from);
			}
			return null;
		}, "move of " + from, identity);
	}

	/**
	 * After a trash restore to a path other than the original one (an explicit {@code to}, or a free name): bookmarks
	 * of the original path that point at nothing now follow the restored entry. A bookmark whose path has meanwhile
	 * been taken by another entry keeps pointing at that one.
	 */
	public void restored(String originalPath, String target, EntryType type, Identity identity) {
		if (originalPath.equals(target)) {
			return;
		}
		String lowerFrom = PathNames.lower(originalPath);
		rekey((kind, path) -> {
			String lower = PathNames.lower(path);
			boolean at = lower.equals(lowerFrom);
			boolean under = type == EntryType.FOLDER && lower.startsWith(lowerFrom + "/");
			if (!(at || under) || exists(path)) {
				return null;
			}
			return at ? target : target + "/" + below(path, originalPath);
		}, "restore of " + originalPath, identity);
	}

	/**
	 * After a heading of {@code notePath} was renamed (ROADMAP item 21): heading bookmarks of that note whose subpath
	 * names {@code from} (in any {@code #} segment, compared like heading targets) name {@code to} instead. Returns how
	 * many bookmarks changed, or would change in a dry run, which writes nothing.
	 */
	public int headingRenamed(String notePath, String from, String to, boolean dryRun, Identity identity) {
		String lowerPath = PathNames.lower(notePath);
		String fromKey = headingKey(from);
		int[] count = { 0 };
		UnaryOperator<ObjectNode> rename = (item) -> {
			String path = BookmarkCodec.text(item, "path");
			String subpath = BookmarkCodec.text(item, "subpath");
			if (path == null || subpath == null || !PathNames.lower(path).equals(lowerPath)) {
				return item;
			}
			String[] segments = subpath.split("#", -1);
			boolean changed = false;
			for (int i = 1; i < segments.length; i++) {
				if (!segments[i].startsWith("^") && headingKey(segments[i]).equals(fromKey)) {
					segments[i] = to;
					changed = true;
				}
			}
			if (!changed) {
				return item;
			}
			count[0]++;
			ObjectNode copy = item.deepCopy();
			copy.put("subpath", String.join("#", segments));
			return copy;
		};
		if (dryRun) {
			try {
				BookmarkCodec.rewriteFileItems(read().items(), rename);
			}
			catch (IOException ex) {
				return 0;
			}
			return count[0];
		}
		change((items) -> BookmarkCodec.rewriteFileItems(items, rename), "heading rename in " + notePath, identity);
		return count[0];
	}

	/** Heading text as heading targets compare it: case-insensitive, whitespace collapsed (DESIGN §6.4). */
	public static String headingKey(String text) {
		return text.replaceAll("(?U)\\s+", " ").trim().toLowerCase(Locale.ROOT);
	}

	private void rekey(BookmarkCodec.PathRewrite rewrite, String what, Identity identity) {
		change((items) -> BookmarkCodec.rewritePaths(items, rewrite), what, identity);
	}

	/** A server-side change: written and announced to every client (origin null) when it changed anything. */
	private boolean change(Function<List<ObjectNode>, @Nullable List<ObjectNode>> edit, String what,
			Identity identity) {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				logger.warn("Bookmarks not updated after the {}: they are busy", what);
				return false;
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return false;
		}
		try {
			Document current = read();
			if (current.broken()) {
				return false;
			}
			List<ObjectNode> items = edit.apply(current.items());
			if (items == null) {
				return false;
			}
			byte[] bytes = serialize(BookmarkCodec.document(current.root(), items));
			write(current, bytes, Author.of(identity));
			String version = Hashing.blobId(bytes);
			this.hub.publish(new BookmarksChangedEvent(version, null));
			logger.info("BOOKMARKS updated after the {}", what);
			return true;
		}
		catch (IOException | RuntimeException ex) {
			logger.warn("Bookmarks not updated after the {}: {}", what, ex.toString());
			return false;
		}
		finally {
			this.lock.unlock();
		}
	}

	/**
	 * The part of {@code path} below {@code folder}, which it is under ignoring case: by segments, because lower-casing
	 * can change the length of a name.
	 */
	static String below(String path, String folder) {
		String rest = path;
		for (int i = PathNames.segmentCount(folder); i > 0; i--) {
			rest = rest.substring(rest.indexOf('/') + 1);
		}
		return rest;
	}

	/** A file or folder exists at exactly this path. */
	private boolean exists(String path) {
		return this.index.file(path) != null || this.index.isFolder(path);
	}

	/** Writes under the lock; a file that was not JSON is kept beside it first, so a hand edit is never lost. */
	private void write(Document current, byte[] bytes, Author author) throws IOException {
		this.batcher.prepareWrite(author);
		if (current.broken()) {
			String backup = FILE + ".bak-" + BACKUP_STAMP.format(this.clock.instant());
			this.fs.atomicWrite(backup, this.fs.readBytes(FILE));
			logger.warn("{} was not valid JSON; kept it as {} before writing", FILE, backup);
		}
		this.fs.atomicWrite(FILE, bytes);
		this.batcher.markDirty(PATH, author);
	}

	private Document read() throws IOException {
		byte[] bytes = readOrNull(FILE);
		if (bytes != null) {
			JsonNode tree = parse(bytes);
			if (!(tree instanceof ObjectNode root)) {
				logger.warn("{} is not a JSON object; it shows no bookmarks until the next change replaces it", FILE);
				return new Document(BookmarkCodec.document(null, List.of()), List.of(), Hashing.blobId(bytes), true,
						true);
			}
			BookmarkCodec.Parsed parsed = BookmarkCodec.readFile(root);
			if (!parsed.errors().isEmpty()) {
				logger.warn("{}: left out invalid bookmarks: {}", FILE, describe(parsed.errors()));
			}
			return new Document(root, parsed.items(), Hashing.blobId(bytes), true, false);
		}
		byte[] obsidian = readOrNull(OBSIDIAN_FILE);
		JsonNode seed = (obsidian != null) ? parse(obsidian) : null;
		List<ObjectNode> items = (seed instanceof ObjectNode) ? BookmarkCodec.readFile(seed).items() : List.of();
		ObjectNode root = BookmarkCodec.document(null, items);
		return new Document(root, items, Hashing.blobId(serialize(root)), false, false);
	}

	private VersionConflictException conflict(Document current) {
		String content = current.onDisk() ? text(FILE) : new String(serialize(current.root()), StandardCharsets.UTF_8);
		BasicFileAttributes attributes = this.fs.attributes(FILE);
		return new VersionConflictException(FILE, current.version(), content,
				(attributes != null) ? attributes.lastModifiedTime().toInstant() : null, null,
				"The bookmarks changed on the server");
	}

	private String text(String disk) {
		byte[] bytes;
		try {
			bytes = readOrNull(disk);
		}
		catch (IOException ex) {
			bytes = null;
		}
		return (bytes != null) ? TextCodec.decode(bytes).text() : "";
	}

	private @Nullable JsonNode parse(byte[] bytes) {
		try {
			return this.mapper.readTree(TextCodec.decode(bytes).text());
		}
		catch (JacksonException ex) {
			return null;
		}
	}

	private byte[] serialize(JsonNode tree) {
		return (this.writer.writeValueAsString(tree) + "\n").getBytes(StandardCharsets.UTF_8);
	}

	private byte @Nullable [] readOrNull(String disk) throws IOException {
		try {
			return this.fs.readBytes(disk);
		}
		catch (NoSuchFileException ex) {
			return null;
		}
	}

	private void lock() {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
	}

	private static int count(List<ObjectNode> items) {
		int n = 0;
		for (ObjectNode item : items) {
			n++;
			if (item.get("items") instanceof ArrayNode children) {
				List<ObjectNode> nested = new ArrayList<>();
				children.values().forEach((child) -> {
					if (child instanceof ObjectNode object) {
						nested.add(object);
					}
				});
				n += count(nested);
			}
		}
		return n;
	}

	private static String describe(List<FieldError> errors) {
		String shown = errors.stream()
			.limit(MAX_REASON_ERRORS)
			.map((e) -> e.field() + " " + e.message())
			.collect(Collectors.joining("; "));
		return (errors.size() > MAX_REASON_ERRORS) ? shown + " (+" + (errors.size() - MAX_REASON_ERRORS) + " more)"
				: shown;
	}

}
