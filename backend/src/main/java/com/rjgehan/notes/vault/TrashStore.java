package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.JsonConfig;
import org.eclipse.jgit.util.sha1.SHA1;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * The flat trash (DESIGN §4.7, §5.7): every trashed file or folder is one top-level item {@code .trash/<name>}, with
 * {@code " 1"}, {@code " 2"}, ... on collisions, and its original path lives only in {@code .notesapp/trash.json}.
 * Every read-modify-write of the metadata and every choice of a trash name happens under this store's lock, taken
 * with {@link #locked}; the other methods must be called while holding it. Listing reconciles the metadata 1:1 with
 * the items actually in {@code .trash/}: entries whose item vanished are dropped, and items without metadata (put
 * there by Obsidian or by hand) are listed with an {@code x-} id.
 */
@Component
public class TrashStore {

	private static final Logger logger = LoggerFactory.getLogger(TrashStore.class);

	public static final String TRASH_DIR = ".trash";

	public static final String METADATA = ".notesapp/trash.json";

	private static final Pattern ID = Pattern.compile("[0-9A-HJKMNP-TV-Z]{12}");

	private static final char[] CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();

	private static final String UNKNOWN = "unknown";

	/** One listed item; {@code trashPath} is its single-segment name under {@code .trash/}. */
	public record Item(String id, String originalPath, String trashPath, EntryType type, Instant deletedAt,
			String deletedBy, long size, int fileCount, boolean tracked) {

		public TrashEntry toEntry() {
			return new TrashEntry(this.id, this.originalPath, this.type, this.deletedAt, this.deletedBy, this.size,
					this.fileCount);
		}

		/** The repo-relative on-disk path of the item. */
		public String disk() {
			return TRASH_DIR + "/" + this.trashPath;
		}

	}

	/** Work done under the store's lock. */
	@FunctionalInterface
	public interface Action<T> {

		T run() throws IOException;

	}

	private final VaultFs fs;

	private final JsonMapper mapper;

	private final Clock clock;

	private final ReentrantLock lock = new ReentrantLock();

	private final SecureRandom random = new SecureRandom();

	public TrashStore(VaultFs fs, JsonMapper mapper, Clock clock) {
		this.fs = fs;
		this.mapper = mapper;
		this.clock = clock;
	}

	/** Runs {@code action} under the store's lock, waiting at most 5 s ({@code 503 busy} otherwise). */
	public <T> T locked(Action<T> action) throws IOException {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
		try {
			return action.run();
		}
		finally {
			this.lock.unlock();
		}
	}

	/** Every item in {@code .trash/}, exactly once each, newest first. */
	public List<Item> list() throws IOException {
		requireLock();
		Map<String, BasicFileAttributes> present = topLevelItems();
		Map<String, Item> byName = new LinkedHashMap<>();
		for (Item item : readMetadata()) {
			if (present.containsKey(item.trashPath())) {
				byName.put(item.trashPath(), item);
			}
		}
		for (Map.Entry<String, BasicFileAttributes> entry : present.entrySet()) {
			if (!byName.containsKey(entry.getKey())) {
				byName.put(entry.getKey(), untracked(entry.getKey(), entry.getValue()));
			}
		}
		List<Item> items = new ArrayList<>(byName.values());
		items.sort(Comparator.comparing(Item::deletedAt).reversed().thenComparing(Item::id));
		return items;
	}

	public @Nullable Item find(String id) throws IOException {
		for (Item item : list()) {
			if (item.id().equals(id)) {
				return item;
			}
		}
		return null;
	}

	/**
	 * Moves the entry at {@code fromDisk} to a free top-level name in {@code .trash/} and records it. A file moves with
	 * a hard link, so it never replaces another item; a folder moves with an atomic rename to a name that is free under
	 * this lock.
	 */
	public Item trash(String fromDisk, String originalPath, EntryType type, String deletedBy, long size,
			int fileCount) throws IOException {
		requireLock();
		Path trash = this.fs.resolve(TRASH_DIR);
		BasicFileAttributes trashAttributes = VaultFs.attributes(trash);
		if (trashAttributes == null) {
			Files.createDirectory(trash);
		}
		else if (!trashAttributes.isDirectory()) {
			throw new IOException(TRASH_DIR + " is not a folder (a symbolic link or a file)");
		}
		// Every name present is taken, listed or not: an atomic rename onto an empty folder would replace it.
		Set<String> taken = new HashSet<>();
		try (DirectoryStream<Path> children = Files.newDirectoryStream(trash)) {
			children.forEach((child) -> taken.add(PathNames.lower(child.getFileName().toString())));
		}
		String name = PathNames.nameOf(fromDisk);
		for (int n = 0; n <= NameRules.MAX_SUFFIX; n++) {
			String candidate = (n == 0) ? name : withSuffix(name, n, type);
			if (taken.contains(PathNames.lower(candidate))) {
				continue;
			}
			try {
				if (type == EntryType.FILE) {
					this.fs.moveExclusive(fromDisk, TRASH_DIR + "/" + candidate);
				}
				else {
					this.fs.moveDirectory(fromDisk, TRASH_DIR + "/" + candidate);
				}
			}
			catch (FileAlreadyExistsException ex) {
				continue;
			}
			List<Item> items = new ArrayList<>(readMetadata());
			Item item = new Item(newId(items), originalPath, candidate, type, this.clock.instant(), deletedBy, size,
					fileCount, true);
			items.add(item);
			writeMetadata(items);
			return item;
		}
		throw new IOException("No free name in the trash for " + name);
	}

	/** Drops the metadata of an item that was moved back into the vault. */
	public void forget(Item item) throws IOException {
		requireLock();
		List<Item> items = new ArrayList<>(readMetadata());
		if (items.removeIf((other) -> other.id().equals(item.id()))) {
			writeMetadata(items);
		}
	}

	/**
	 * Takes one item out of the trash for good: it is renamed into {@code .notesapp/tmp} and forgotten. Deleting it,
	 * which takes as long as the item is large, is the caller's job once its locks are released (DESIGN §5.4: no long
	 * work under a lock); see {@link VaultFs#stageForDeletion}. Returns the path to delete, or null when there is none.
	 */
	public @Nullable Path purge(Item item) throws IOException {
		requireLock();
		Path staged = this.fs.stageForDeletion(this.fs.resolve(item.disk()));
		forget(item);
		return staged;
	}

	/** What {@link #empty} took out: the number of items, and the staged paths to delete after the locks. */
	public record Emptied(int count, List<Path> staged) {
	}

	/** Takes every item out of the trash for good, like {@link #purge}. */
	public Emptied empty() throws IOException {
		requireLock();
		List<Item> items = list();
		Path trash = this.fs.resolve(TRASH_DIR);
		List<Path> staged = new ArrayList<>();
		if (VaultFs.attributes(trash) != null) {
			List<Path> children;
			try (DirectoryStream<Path> listing = Files.newDirectoryStream(trash)) {
				children = new ArrayList<>();
				listing.forEach(children::add);
			}
			for (Path child : children) {
				Path path = this.fs.stageForDeletion(child);
				if (path != null) {
					staged.add(path);
				}
			}
		}
		writeMetadata(List.of());
		return new Emptied(items.size(), List.copyOf(staged));
	}

	// ---------------------------------------------------------------- internals

	/**
	 * The top-level items of {@code .trash/} by on-disk name; the folder being absent means an empty trash. Hidden
	 * like in the vault walk (§4.5): dot-names, and ignored names (editor temp files such as {@code x.tmp}) only for
	 * files, because a folder with such a name is indexed and can be deleted through the app.
	 */
	private Map<String, BasicFileAttributes> topLevelItems() throws IOException {
		Map<String, BasicFileAttributes> items = new LinkedHashMap<>();
		Path trash = this.fs.resolve(TRASH_DIR);
		BasicFileAttributes trashAttributes = VaultFs.attributes(trash);
		if (trashAttributes == null || !trashAttributes.isDirectory()) {
			return items;
		}
		try (DirectoryStream<Path> children = Files.newDirectoryStream(trash)) {
			for (Path child : children) {
				BasicFileAttributes attributes = VaultFs.attributes(child);
				String name = child.getFileName().toString();
				if (attributes != null && !name.startsWith(".")
						&& (attributes.isDirectory() || !NameRules.isIgnored(name))) {
					items.put(name, attributes);
				}
			}
		}
		return items;
	}

	/** An item without metadata: listed under its name, with an {@code x-} id derived from that name. */
	private Item untracked(String name, BasicFileAttributes attributes) throws IOException {
		long[] totals = { 0, 0 };
		EntryType type = attributes.isDirectory() ? EntryType.FOLDER : EntryType.FILE;
		if (type == EntryType.FOLDER) {
			Files.walkFileTree(this.fs.resolve(TRASH_DIR + "/" + name), new SimpleFileVisitor<>() {

				@Override
				public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
					if (attrs.isRegularFile()) {
						totals[0] += attrs.size();
						totals[1]++;
					}
					return FileVisitResult.CONTINUE;
				}

				@Override
				public FileVisitResult visitFileFailed(Path file, IOException exc) {
					return FileVisitResult.CONTINUE;
				}

			});
		}
		else {
			totals[0] = attributes.isRegularFile() ? attributes.size() : 0;
			totals[1] = 1;
		}
		return new Item(untrackedId(name), Normalizer.normalize(name, Normalizer.Form.NFC), name, type,
				attributes.lastModifiedTime().toInstant(), UNKNOWN, totals[0], (int) totals[1], false);
	}

	static String untrackedId(String name) {
		SHA1 sha1 = SHA1.newInstance();
		sha1.update(name.getBytes(StandardCharsets.UTF_8));
		return "x-" + sha1.toObjectId().name().substring(0, 16);
	}

	private List<Item> readMetadata() throws IOException {
		byte[] bytes;
		try {
			bytes = this.fs.readBytes(METADATA);
		}
		catch (NoSuchFileException ex) {
			return List.of();
		}
		JsonNode root;
		try {
			root = this.mapper.readTree(bytes);
		}
		catch (JacksonException ex) {
			logger.warn("{} is not valid JSON; trashed items are listed without their original paths", METADATA);
			return List.of();
		}
		JsonNode entries = (root != null) ? root.get("entries") : null;
		if (entries == null || !entries.isArray()) {
			return List.of();
		}
		List<Item> items = new ArrayList<>();
		for (JsonNode entry : entries.values()) {
			Item item = parseEntry(entry);
			if (item != null) {
				items.add(item);
			}
		}
		return items;
	}

	private @Nullable Item parseEntry(JsonNode entry) {
		String id = text(entry, "id");
		String originalPath = text(entry, "originalPath");
		String trashPath = text(entry, "trashPath");
		String type = text(entry, "type");
		String deletedAt = text(entry, "deletedAt");
		if (id == null || !ID.matcher(id).matches() || originalPath == null || trashPath == null || type == null
				|| deletedAt == null) {
			logger.warn("Ignoring a malformed entry in {}", METADATA);
			return null;
		}
		if (!isSingleSegment(trashPath)) {
			logger.warn("Ignoring the entry {} in {}: its trashPath is not a single name under .trash", id, METADATA);
			return null;
		}
		try {
			String deletedBy = text(entry, "deletedBy");
			JsonNode size = entry.get("size");
			JsonNode fileCount = entry.get("fileCount");
			return new Item(id, originalPath, trashPath, "folder".equals(type) ? EntryType.FOLDER : EntryType.FILE,
					Instant.parse(deletedAt), (deletedBy != null) ? deletedBy : UNKNOWN,
					(size != null && size.canConvertToLong()) ? size.longValue() : 0,
					(fileCount != null && fileCount.canConvertToInt()) ? fileCount.intValue() : 0, true);
		}
		catch (DateTimeParseException ex) {
			logger.warn("Ignoring the entry {} in {}: invalid deletedAt", id, METADATA);
			return null;
		}
	}

	/** A trash name must be one safe segment, so a hand-edited file cannot point outside {@code .trash/}. */
	private static boolean isSingleSegment(String name) {
		if (name.isEmpty() || name.equals(".") || name.equals("..") || name.length() > 255) {
			return false;
		}
		for (int i = 0; i < name.length(); i++) {
			char c = name.charAt(i);
			// On Windows a colon would address an alternate data stream of another file.
			if (c == '/' || c == '\\' || c < 0x20 || c == 0x7f || (c == ':' && VaultPaths.isWindows())) {
				return false;
			}
		}
		return true;
	}

	private static @Nullable String text(JsonNode node, String field) {
		JsonNode value = node.get(field);
		return (value != null && value.isString()) ? value.stringValue() : null;
	}

	private void writeMetadata(List<Item> items) throws IOException {
		ObjectNode root = JsonNodeFactory.instance.objectNode();
		root.put("schemaVersion", 1);
		ArrayNode entries = root.putArray("entries");
		for (Item item : items) {
			if (!item.tracked()) {
				continue;
			}
			ObjectNode entry = entries.addObject();
			entry.put("id", item.id());
			entry.put("originalPath", item.originalPath());
			entry.put("trashPath", item.trashPath());
			entry.put("type", (item.type() == EntryType.FOLDER) ? "folder" : "file");
			entry.put("deletedAt", JsonConfig.formatInstant(item.deletedAt()));
			entry.put("deletedBy", item.deletedBy());
			entry.put("size", item.size());
			entry.put("fileCount", item.fileCount());
		}
		Files.createDirectories(this.fs.resolve(METADATA).getParent());
		this.fs.atomicWrite(METADATA, this.mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(root));
	}

	private String newId(List<Item> existing) {
		Set<String> ids = new HashSet<>();
		existing.forEach((item) -> ids.add(item.id()));
		while (true) {
			char[] id = new char[12];
			for (int i = 0; i < id.length; i++) {
				id[i] = CROCKFORD[this.random.nextInt(CROCKFORD.length)];
			}
			String candidate = new String(id);
			if (!ids.contains(candidate)) {
				return candidate;
			}
		}
	}

	private static String withSuffix(String name, int n, EntryType type) {
		return (type == EntryType.FILE) ? NameRules.withSuffix(name, n) : name + " " + n;
	}

	private void requireLock() {
		if (!this.lock.isHeldByCurrentThread()) {
			throw new IllegalStateException("The trash store lock is not held");
		}
	}

}
