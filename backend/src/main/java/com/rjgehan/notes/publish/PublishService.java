package com.rjgehan.notes.publish;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.PublishResponse;
import com.rjgehan.notes.api.dto.PublishedNote;
import com.rjgehan.notes.api.dto.PublishedNoteState;
import com.rjgehan.notes.api.dto.TextFile;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Service;

/**
 * Public publishing (ROADMAP item 26, DESIGN §5.28). {@code .notesapp/publish.json} lists the published notes (path,
 * slug, title, when, the version published and the snapshot's attachments) and is committed like the bookmarks; the
 * snapshots themselves live outside the vault in {@link SnapshotStore}. Publishing renders the note once, at that
 * moment: the public server never reads the vault.
 */
@Service
public class PublishService {

	private static final Logger logger = LoggerFactory.getLogger(PublishService.class);

	public static final String FILE = ".notesapp/publish.json";

	private static final ApiPath PATH = ApiPath.of(FILE);

	private static final int MAX_TITLE = 200;

	private static final String SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

	private static final SecureRandom RANDOM = new SecureRandom();

	/** One published note as stored in {@code publish.json}. */
	public record Entry(String path, String slug, String title, Instant publishedAt, String sourceVersion,
			List<String> assets) {
	}

	/** The document {@code publish.json} holds. */
	public record Manifest(List<Entry> notes) {
	}

	private final NotesProperties.Publish properties;

	private final VaultFs fs;

	private final VaultIndex index;

	private final FileService files;

	private final CommitBatcher batcher;

	private final SnapshotStore snapshots;

	private final Clock clock;

	private final JsonMapper mapper;

	private final ReentrantLock lock = new ReentrantLock();

	public PublishService(NotesProperties properties, VaultFs fs, VaultIndex index, FileService files,
			CommitBatcher batcher, SnapshotStore snapshots, Clock clock, JsonMapper mapper) {
		this.properties = properties.publish();
		this.fs = fs;
		this.index = index;
		this.files = files;
		this.batcher = batcher;
		this.snapshots = snapshots;
		this.clock = clock;
		this.mapper = mapper;
	}

	public boolean enabled() {
		return this.properties.enabled();
	}

	/** {@code GET /api/publish}. */
	public PublishResponse list() throws IOException {
		Manifest manifest = read();
		refreshServed(manifest);
		List<PublishedNote> notes = manifest.notes().stream().map(this::view).toList();
		String base = this.properties.baseUrl().isBlank() ? null : stripSlash(this.properties.baseUrl());
		return new PublishResponse(enabled(), base, notes);
	}

	/** {@code POST /api/publish}: publishes the note, or republishes it (a new snapshot, maybe a new slug). */
	public PublishedNote publish(@Nullable String rawPath, @Nullable String rawSlug, @Nullable String rawTitle,
			Identity identity) throws IOException {
		if (!enabled()) {
			throw new NotesException(ErrorCode.PUBLISHING_OFF,
					"Public publishing is off; it is switched on with NOTES_PUBLISH_ENABLED (DEPLOY.md)");
		}
		if (rawPath == null || rawPath.isBlank()) {
			throw NotesException.badRequest("path is required");
		}
		String path = nfc(rawPath);
		if (path.toLowerCase(Locale.ROOT).endsWith(".mdenc")) {
			throw NotesException.badRequest("Encrypted notes cannot be published");
		}
		if (!PathNames.isMarkdown(path) || path.toLowerCase(Locale.ROOT).endsWith(".excalidraw.md")) {
			throw NotesException.badRequest("Only notes can be published");
		}
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				Manifest manifest = read();
				Entry previous = find(manifest, path);
				TextFile note = this.files.readText(path);
				if (note.kind() != FileKind.NOTE) {
					throw NotesException.badRequest("Only notes can be published");
				}
				String title = title(rawTitle, previous, note.path());
				String slug = slug(rawSlug, previous, title, manifest, note.path());
				Instant now = this.clock.instant();

				Map<String, String> slugs = new HashMap<>();
				Map<String, String> titles = new HashMap<>();
				for (Entry entry : manifest.notes()) {
					slugs.put(entry.path(), entry.slug());
					titles.put(entry.path(), entry.title());
				}
				slugs.put(note.path(), slug);
				titles.put(note.path(), title);
				Map<String, Path> assets = new LinkedHashMap<>();
				String body = PublishRenderer.renderBody(note.path(), note.content(),
						context(note.path(), slugs, titles, assets));
				String html = PublishPage.document(title, body, now);
				this.snapshots.write(slug, html, assets);
				if (previous != null && !previous.slug().equals(slug)) {
					this.snapshots.delete(previous.slug());
				}

				Entry entry = new Entry(note.path(), slug, title, now, note.version(), List.copyOf(assets.keySet()));
				List<Entry> notes = new ArrayList<>();
				boolean replaced = false;
				for (Entry existing : manifest.notes()) {
					if (existing.path().equals(note.path())) {
						notes.add(entry);
						replaced = true;
					}
					else {
						notes.add(existing);
					}
				}
				if (!replaced) {
					notes.add(entry);
				}
				Manifest next = new Manifest(List.copyOf(notes));
				write(next, Author.of(identity));
				refreshServed(next);
				logger.info("PUBLISH {} as /p/{} assets={} user={}", note.path(), slug, assets.size(),
						identity.login());
				return view(entry);
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	/** {@code DELETE /api/publish?path=}: the snapshot is deleted at once and the note leaves the list. */
	public void unpublish(@Nullable String rawPath, Identity identity) throws IOException {
		if (rawPath == null || rawPath.isBlank()) {
			throw NotesException.badRequest("path is required");
		}
		String path = nfc(rawPath);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				Manifest manifest = read();
				Entry entry = find(manifest, path);
				if (entry == null) {
					throw new NotesException(ErrorCode.NOT_FOUND, "That note is not published", Map.of("path", path));
				}
				List<Entry> notes = manifest.notes().stream().filter((e) -> !e.path().equals(path)).toList();
				Manifest next = new Manifest(notes);
				// Stop serving first, then delete: no request can be answered from a half-deleted snapshot.
				refreshServed(next);
				this.snapshots.delete(entry.slug());
				write(next, Author.of(identity));
				logger.info("UNPUBLISH {} (/p/{}) user={}", path, entry.slug(), identity.login());
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	/**
	 * After a move or rename through the app (the caller holds the vault write lock): published notes keep their slug
	 * and follow the note. The snapshot is unchanged. A failure is logged; the move has happened anyway.
	 */
	public void moved(String from, String to, EntryType type, Identity identity) {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				logger.warn("Published notes not updated after the move of {}: busy", from);
				return;
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return;
		}
		try {
			Manifest manifest = read();
			boolean changed = false;
			List<Entry> notes = new ArrayList<>();
			for (Entry entry : manifest.notes()) {
				String path = entry.path();
				String next = null;
				if (path.equals(from)) {
					next = to;
				}
				else if (type == EntryType.FOLDER && path.startsWith(from + "/")) {
					next = to + path.substring(from.length());
				}
				if (next != null) {
					changed = true;
					notes.add(new Entry(next, entry.slug(), entry.title(), entry.publishedAt(), entry.sourceVersion(),
							entry.assets()));
				}
				else {
					notes.add(entry);
				}
			}
			if (changed) {
				write(new Manifest(notes), Author.of(identity));
			}
		}
		catch (IOException | RuntimeException ex) {
			logger.warn("Published notes not updated after the move of {}: {}", from, ex.toString());
		}
		finally {
			this.lock.unlock();
		}
	}

	/** Loads what the publish server may serve from {@code publish.json} and the snapshots on disk. */
	public void loadServed() {
		this.snapshots.cleanUp();
		try {
			refreshServed(read());
		}
		catch (IOException | RuntimeException ex) {
			logger.warn("{} could not be read; nothing is published until it can: {}", FILE, ex.toString());
			this.snapshots.setServed(Map.of());
		}
	}

	private void refreshServed(Manifest manifest) {
		Map<String, Set<String>> served = new HashMap<>();
		for (Entry entry : manifest.notes()) {
			if (this.snapshots.exists(entry.slug())) {
				served.put(entry.slug(), Set.copyOf(entry.assets()));
			}
		}
		this.snapshots.setServed(served);
	}

	private PublishedNote view(Entry entry) {
		FileRecord record = this.index.file(entry.path());
		PublishedNoteState state;
		if (!this.snapshots.exists(entry.slug())) {
			state = PublishedNoteState.SNAPSHOT_MISSING;
		}
		else if (record == null) {
			state = PublishedNoteState.SOURCE_MISSING;
		}
		else if (record.version() != null && !record.version().equals(entry.sourceVersion())) {
			state = PublishedNoteState.CHANGED;
		}
		else {
			state = PublishedNoteState.CURRENT;
		}
		String base = this.properties.baseUrl().isBlank() ? "" : stripSlash(this.properties.baseUrl());
		return new PublishedNote(entry.path(), entry.slug(), entry.title(), base + "/p/" + entry.slug(),
				entry.publishedAt(), state);
	}

	private PublishRenderer.Context context(String notePath, Map<String, String> slugs, Map<String, String> titles,
			Map<String, Path> assets) {
		long maxAsset = this.properties.maxAssetSize().toBytes();
		return new PublishRenderer.Context() {

			@Override
			public @Nullable String resolve(String target) {
				return PublishService.this.index.resolveLink(target, notePath);
			}

			@Override
			public FileKind kindOf(String path) {
				FileRecord record = PublishService.this.index.file(path);
				return (record != null) ? record.kind() : FileKind.OTHER;
			}

			@Override
			public @Nullable String slugOf(String path) {
				return slugs.get(path);
			}

			@Override
			public @Nullable String titleOf(String path) {
				return titles.get(path);
			}

			@Override
			public @Nullable String asset(String path) {
				try {
					FileService.RawFile raw = PublishService.this.files.openRaw(path);
					if (raw.size() > maxAsset) {
						logger.info("Left {} out of a published snapshot: larger than {}", path,
								PublishService.this.properties.maxAssetSize());
						return null;
					}
					String extension = PathNames.extensionOf(PathNames.nameOf(path));
					if (!extension.matches("[a-z0-9]{1,10}")) {
						return null;
					}
					String name = SnapshotStore.assetName(raw.file(), extension);
					assets.put(name, raw.file());
					return name;
				}
				catch (IOException | RuntimeException ex) {
					logger.info("Left {} out of a published snapshot: {}", path, ex.toString());
					return null;
				}
			}

		};
	}

	private static String title(@Nullable String raw, @Nullable Entry previous, String path) {
		String title = (raw != null) ? raw.strip() : (previous != null) ? previous.title() : "";
		if (title.isEmpty()) {
			title = PathNames.basenameOf(PathNames.nameOf(path));
		}
		if (title.length() > MAX_TITLE || title.chars().anyMatch((c) -> c < 0x20 || c == 0x7f)) {
			throw NotesException.badRequest("The title must be at most " + MAX_TITLE + " characters on one line");
		}
		return title;
	}

	private static String slug(@Nullable String raw, @Nullable Entry previous, String title, Manifest manifest,
			String path) {
		if (raw != null && !raw.isBlank()) {
			String slug = raw.strip();
			if (!SnapshotStore.SLUG.matcher(slug).matches()) {
				throw NotesException.badRequest(
						"The address must be 1 to 80 lower-case letters, digits and inner hyphens");
			}
			Entry owner = bySlug(manifest, slug);
			if (owner != null && !owner.path().equals(path)) {
				throw new NotesException(ErrorCode.ALREADY_EXISTS, "Another note is published at /p/" + slug,
						Map.of("existingPath", owner.path()));
			}
			return slug;
		}
		if (previous != null) {
			return previous.slug();
		}
		String base = slugify(title);
		if (base.isEmpty()) {
			base = randomSlug();
		}
		String slug = base;
		for (int n = 2; bySlug(manifest, slug) != null; n++) {
			String suffix = "-" + n;
			slug = trimSlug(base.substring(0, Math.min(base.length(), 80 - suffix.length()))) + suffix;
		}
		return slug;
	}

	/** Lower-case ASCII letters and digits of {@code text}, everything else collapsed to single hyphens. */
	static String slugify(String text) {
		String plain = Normalizer.normalize(text, Normalizer.Form.NFKD).replaceAll("\\p{M}+", "");
		StringBuilder out = new StringBuilder();
		boolean hyphen = false;
		for (int i = 0; i < plain.length() && out.length() < 60; i++) {
			char c = Character.toLowerCase(plain.charAt(i));
			if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
				if (hyphen && out.length() > 0) {
					out.append('-');
				}
				out.append(c);
				hyphen = false;
			}
			else {
				hyphen = true;
			}
		}
		return trimSlug(out.toString());
	}

	private static String trimSlug(String slug) {
		String s = slug;
		while (s.endsWith("-")) {
			s = s.substring(0, s.length() - 1);
		}
		return s;
	}

	private static String randomSlug() {
		StringBuilder out = new StringBuilder(10);
		for (int i = 0; i < 10; i++) {
			out.append(SLUG_ALPHABET.charAt(RANDOM.nextInt(SLUG_ALPHABET.length())));
		}
		return out.toString();
	}

	private static @Nullable Entry find(Manifest manifest, String path) {
		return manifest.notes().stream().filter((e) -> e.path().equals(path)).findFirst().orElse(null);
	}

	private static @Nullable Entry bySlug(Manifest manifest, String slug) {
		return manifest.notes().stream().filter((e) -> e.slug().equals(slug)).findFirst().orElse(null);
	}

	private Manifest read() throws IOException {
		byte[] bytes;
		try {
			bytes = this.fs.readBytes(FILE);
		}
		catch (NoSuchFileException ex) {
			return new Manifest(List.of());
		}
		try {
			Manifest manifest = this.mapper.readValue(TextCodec.decode(bytes).text(), Manifest.class);
			if (manifest == null || manifest.notes() == null) {
				return new Manifest(List.of());
			}
			// Hand edits are taken only as far as they are well-formed: a bad slug is never served.
			Set<String> slugs = new LinkedHashSet<>();
			List<Entry> valid = new ArrayList<>();
			for (Entry entry : manifest.notes()) {
				if (entry != null && entry.path() != null && entry.slug() != null
						&& SnapshotStore.SLUG.matcher(entry.slug()).matches() && slugs.add(entry.slug())) {
					List<String> assets = (entry.assets() != null) ? entry.assets()
						.stream()
						.filter((a) -> a != null && SnapshotStore.ASSET.matcher(a).matches())
						.toList() : List.of();
					valid.add(new Entry(entry.path(), entry.slug(), (entry.title() != null) ? entry.title() : entry.slug(),
							(entry.publishedAt() != null) ? entry.publishedAt() : Instant.EPOCH,
							(entry.sourceVersion() != null) ? entry.sourceVersion() : "", assets));
				}
			}
			return new Manifest(List.copyOf(valid));
		}
		catch (JacksonException ex) {
			throw new NotesException(ErrorCode.MALFORMED_FILE, FILE + " is not valid; fix or delete it",
					Map.of("path", FILE));
		}
	}

	private void write(Manifest manifest, Author author) throws IOException {
		byte[] bytes = (this.mapper.writerWithDefaultPrettyPrinter().writeValueAsString(manifest) + "\n")
			.getBytes(StandardCharsets.UTF_8);
		this.batcher.prepareWrite(author);
		this.fs.atomicWrite(FILE, bytes);
		this.batcher.markDirty(PATH, author);
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

	private static String nfc(String path) {
		return Normalizer.normalize(path, Normalizer.Form.NFC);
	}

	private static String stripSlash(String url) {
		String s = url.strip();
		while (s.endsWith("/")) {
			s = s.substring(0, s.length() - 1);
		}
		return s;
	}

}
