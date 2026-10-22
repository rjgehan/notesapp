package com.rjgehan.notes.vault;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.TextFile;
import com.rjgehan.notes.api.dto.WriteResult;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.FolderEvent;
import com.rjgehan.notes.events.TrashChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.CommitFailedException;
import com.rjgehan.notes.history.LargeFiles;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Text read, create and save, raw read and upload, and the building blocks other services reuse: <em>preserve
 * before overwrite</em>, parent-folder creation and indexing (DESIGN §5.4). Every write follows the same order: locks,
 * checks against the bytes on disk, the write, the index swap, {@code markDirty}, and publishing before the locks are
 * released.
 */
@Service
public class FileService {

	private static final Logger logger = LoggerFactory.getLogger(FileService.class);

	/** A write's result and whether it created the file (201) or replaced it (200). */
	public record Saved(WriteResult result, boolean created) {
	}

	/** A file to serve raw; size and mtime come from the same stat as the bytes' path. */
	public record RawFile(ApiPath path, Path file, long size, Instant mtime) {
	}

	public enum UploadConflict {

		FAIL, RENAME, OVERWRITE

	}

	@FunctionalInterface
	private interface Creator {

		void create(ApiPath target) throws IOException;

	}

	/** The created target, still under the locks of the create until the caller has indexed and published it. */
	private record Created(ApiPath target, List<String> createdFolders, VaultLocks.Held locks)
			implements AutoCloseable {

		@Override
		public void close() {
			this.locks.close();
		}

	}

	private final VaultPaths paths;

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileKinds kinds;

	private final FileIndexer indexer;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final MoveLog moveLog;

	private final TrashStore trashStore;

	private final LargeFiles largeFiles;

	private final long maxUploadSize;

	private final long minFreeSpace;

	public FileService(VaultPaths paths, VaultFs fs, VaultLocks locks, VaultIndex index, FileKinds kinds,
			FileIndexer indexer, VaultReconciler reconciler, CommitBatcher batcher, EventHub hub, MoveLog moveLog,
			TrashStore trashStore, LargeFiles largeFiles, NotesProperties properties) {
		this.paths = paths;
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.kinds = kinds;
		this.indexer = indexer;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
		this.moveLog = moveLog;
		this.trashStore = trashStore;
		this.largeFiles = largeFiles;
		this.maxUploadSize = properties.limits().maxUploadSize().toBytes();
		this.minFreeSpace = properties.limits().minFreeSpace().toBytes();
	}

	// ---------------------------------------------------------------- text

	/**
	 * {@code GET /api/files}: the decoded text (BOM stripped) and the version of the bytes on disk. Like every GET it
	 * changes nothing: an external edit the watcher has not reconciled yet is returned as it is on disk, and the
	 * watcher, the rescan or the next write indexes and announces it.
	 */
	public TextFile readText(String apiPath) throws IOException {
		ApiPath path = this.paths.resolveForRead(apiPath);
		FileRecord record = requireFile(path);
		FileKind kind = record.kind();
		if (!kind.isText()) {
			throw NotesException.notText(path.nfc(), kind.wireName());
		}
		long limit = this.kinds.textLimit(path.nfc());
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		if (attributes == null || !attributes.isRegularFile()) {
			throw NotesException.notFound(path.nfc());
		}
		if (attributes.size() > limit) {
			throw NotesException.tooLarge(limit, "The file is larger than the text limit; download it raw instead");
		}
		byte[] bytes = this.fs.readBytes(path.disk());
		if (bytes.length > limit) {
			throw NotesException.tooLarge(limit, "The file is larger than the text limit; download it raw instead");
		}
		String version = Hashing.blobId(bytes);
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		return new TextFile(path.nfc(), kind, decoded.text(), version, bytes.length,
				attributes.lastModifiedTime().toInstant(), decoded.lossy());
	}

	/** {@code POST /api/files}: creates a new text file; never replaces an existing one. */
	public WriteResult createText(String apiPath, String content, OnConflict onConflict, Identity identity,
			@Nullable String origin) throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.NEW);
		requireTextKind(path);
		byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
		requireWithinTextLimit(path, bytes.length);
		Author author = Author.of(identity);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				Created created = createNew(path, onConflict == OnConflict.RENAME,
						(target) -> this.fs.createExclusive(target.disk(), bytes), author)) {
			FileEntry entry = indexWritten(created.target(), bytes);
			this.batcher.markDirty(created.target(), author);
			publishFolders(created.createdFolders(), origin);
			this.hub.publish(FileEvent.created(entry, origin));
			logger.info("CREATE {} client={} user={}", entry.path(), origin, identity.login());
			return new WriteResult(entry, true, created.createdFolders());
		}
	}

	/**
	 * {@code PUT /api/files}: the save flow and conflict protocol of API.md §4. The disk, not the index, is the source
	 * of truth; equal bytes always succeed, so a retried save never conflicts with its own text.
	 */
	public Saved saveText(String apiPath, String content, @Nullable String baseVersion, boolean flushHistory,
			Identity identity, @Nullable String origin) throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		requireTextKind(path);
		byte[] contentBytes = content.getBytes(StandardCharsets.UTF_8);
		long limit = this.kinds.textLimit(path.nfc());
		requireWithinTextLimit(path, contentBytes.length);
		Author author = Author.of(identity);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.read(lockPaths(path))) {
			if (this.index.isFolder(path.nfc())) {
				throw NotesException.typeMismatch(path.nfc(), "file", "A folder exists at " + path.nfc());
			}
			byte[] disk = (existingLocked(path) != null) ? readOrNull(path) : null;
			if (disk == null) {
				if (baseVersion != null) {
					throw new VersionConflictException(path.nfc(), null, null, null, this.moveLog.movedTo(path.nfc()));
				}
				return new Saved(recreate(path, contentBytes, author, origin), true);
			}
			if (disk.length > limit) {
				throw NotesException.tooLarge(limit, "The file on the server is larger than the text limit");
			}
			byte[] newBytes = TextCodec.hasBom(disk) ? TextCodec.encode(content, true) : contentBytes;
			String current = Hashing.blobId(disk);
			FileRecord record = this.index.file(path.nfc());
			if (record == null || !current.equals(record.version())) {
				this.reconciler.reconcileLocked(path);
			}
			if (Hashing.blobId(newBytes).equals(current)) {
				return new Saved(new WriteResult(currentEntry(path), false, List.of()), false);
			}
			if (!current.equals(baseVersion)) {
				preserveQuietly(path);
				throw conflict(path, disk, current);
			}
			if (flushHistory) {
				preserve(path);
			}
			this.batcher.prepareWrite(author);
			this.fs.atomicWrite(path.disk(), newBytes);
			FileEntry entry = indexWritten(path, newBytes);
			this.batcher.markDirty(path, author);
			this.hub.publish(FileEvent.changed(entry, origin));
			logger.debug("SAVE {} client={} {} bytes", entry.path(), origin, newBytes.length);
			return new Saved(new WriteResult(entry, false, List.of()), false);
		}
	}

	/**
	 * Quick capture (API.md §8.5): appends {@code entry} (LF line breaks, ending with one) to the text file at
	 * {@code apiPath}, or creates it with {@code initialContent} followed by the entry. An existing file is found
	 * ignoring case. Its bytes are kept exactly (BOM, invalid UTF-8 and all); the entry follows the file's line
	 * endings and starts on a new line. Nothing the requester has not seen is replaced, so no conflict is possible:
	 * other clients get {@code file.changed} and an open, dirty note there enters the ordinary conflict flow.
	 */
	public Saved appendText(String apiPath, String entry, Supplier<String> initialContent, Identity identity,
			@Nullable String origin) throws IOException {
		String nfc = this.paths.normalize(apiPath);
		for (int attempt = 0;; attempt++) {
			String existing = this.index.fileIgnoreCase(nfc);
			if (existing == null) {
				try {
					WriteResult created = createText(nfc, initialContent.get() + entry, OnConflict.FAIL, identity,
							origin);
					return new Saved(created, true);
				}
				catch (NotesException ex) {
					// Created meanwhile (another capture, today's note opened on another device): append to it.
					boolean raced = ex.code() == ErrorCode.ALREADY_EXISTS || ex.code() == ErrorCode.CASE_COLLISION;
					if (!raced || attempt >= 2) {
						throw ex;
					}
					continue;
				}
			}
			Saved appended = appendExisting(this.paths.resolve(existing, Mode.EXISTING), entry, identity, origin);
			if (appended != null) {
				return appended;
			}
			if (attempt >= 2) {
				throw NotesException.notFound(existing);
			}
		}
	}

	/** Appends under the locks; null when the file vanished meanwhile (the caller creates it). */
	private @Nullable Saved appendExisting(ApiPath path, String entry, Identity identity, @Nullable String origin)
			throws IOException {
		requireTextKind(path);
		long limit = this.kinds.textLimit(path.nfc());
		Author author = Author.of(identity);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.read(lockPaths(path))) {
			if (existingLocked(path) == null) {
				return null;
			}
			byte[] disk = readOrNull(path);
			if (disk == null) {
				return null;
			}
			FileRecord record = this.index.file(path.nfc());
			if (record == null || !Hashing.blobId(disk).equals(record.version())) {
				// An external edit the watcher has not indexed yet: index and announce it first.
				this.reconciler.reconcileLocked(path);
			}
			byte[] addition = appendBytes(disk, entry);
			if ((long) disk.length + addition.length > limit) {
				throw NotesException.tooLarge(limit, "Text files are limited to " + limit + " bytes");
			}
			byte[] newBytes = new byte[disk.length + addition.length];
			System.arraycopy(disk, 0, newBytes, 0, disk.length);
			System.arraycopy(addition, 0, newBytes, disk.length, addition.length);
			this.batcher.prepareWrite(author);
			this.fs.atomicWrite(path.disk(), newBytes);
			FileEntry entryAfter = indexWritten(path, newBytes);
			this.batcher.markDirty(path, author);
			this.hub.publish(FileEvent.changed(entryAfter, origin));
			logger.info("CAPTURE {} client={} user={}", entryAfter.path(), origin, identity.login());
			return new Saved(new WriteResult(entryAfter, false, List.of()), false);
		}
	}

	/** A server-side edit of a text file's current content (see {@link #editText}). */
	@FunctionalInterface
	public interface TextEdit<T> {

		/** The new text and a value for the caller; a null text leaves the file as it is. */
		Edit<T> apply(String text);

	}

	public record Edit<T>(@Nullable String text, T value) {
	}

	public record Edited<T>(FileEntry file, T value, boolean changed) {
	}

	/**
	 * Applies {@code edit} to the file's current content on disk, under its lock (adding a block id, API.md §37). Like a
	 * capture, nothing the requester has not seen is replaced: the edit reads the latest text itself, other clients get
	 * {@code file.changed}, and an open, dirty note there merges or enters the ordinary conflict flow. The BOM is kept;
	 * a file with invalid UTF-8 is never rewritten.
	 */
	public <T> Edited<T> editText(String apiPath, TextEdit<T> edit, Identity identity, @Nullable String origin)
			throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		requireTextKind(path);
		long limit = this.kinds.textLimit(path.nfc());
		Author author = Author.of(identity);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.read(lockPaths(path))) {
			byte[] disk = (existingLocked(path) != null) ? readOrNull(path) : null;
			if (disk == null) {
				throw NotesException.notFound(path.nfc());
			}
			if (disk.length > limit) {
				throw NotesException.tooLarge(limit, "The file is larger than the text limit");
			}
			FileRecord record = this.index.file(path.nfc());
			if (record == null || !Hashing.blobId(disk).equals(record.version())) {
				this.reconciler.reconcileLocked(path);
			}
			TextCodec.Decoded decoded = TextCodec.decode(disk);
			if (decoded.lossy()) {
				throw NotesException.badRequest("The file contains invalid UTF-8 and is never rewritten");
			}
			Edit<T> result = edit.apply(decoded.text());
			if (result.text() == null || result.text().equals(decoded.text())) {
				return new Edited<>(currentEntry(path), result.value(), false);
			}
			byte[] newBytes = TextCodec.encode(result.text(), decoded.hadBom());
			if (newBytes.length > limit) {
				throw NotesException.tooLarge(limit, "Text files are limited to " + limit + " bytes");
			}
			this.batcher.prepareWrite(author);
			this.fs.atomicWrite(path.disk(), newBytes);
			FileEntry entry = indexWritten(path, newBytes);
			this.batcher.markDirty(path, author);
			this.hub.publish(FileEvent.changed(entry, origin));
			logger.info("EDIT {} client={} user={}", entry.path(), origin, identity.login());
			return new Edited<>(entry, result.value(), true);
		}
	}

	/**
	 * The bytes that append {@code entry} (LF-only) to a file holding {@code disk}: on a new line, in the file's line
	 * endings (CRLF when every line break in it is CRLF, DESIGN §6.9).
	 */
	static byte[] appendBytes(byte[] disk, String entry) {
		int lf = 0;
		int crlf = 0;
		for (int i = 0; i < disk.length; i++) {
			if (disk[i] == '\n') {
				lf++;
				if (i > 0 && disk[i - 1] == '\r') {
					crlf++;
				}
			}
		}
		String eol = (lf > 0 && lf == crlf) ? "\r\n" : "\n";
		boolean bomOnly = disk.length == 3 && TextCodec.hasBom(disk);
		boolean needsBreak = disk.length > 0 && !bomOnly && disk[disk.length - 1] != '\n';
		String text = (needsBreak ? "\n" : "") + entry;
		return text.replace("\n", eol).getBytes(StandardCharsets.UTF_8);
	}

	/** "Recreate with my text": the name existed, so neither the name nor its parents get the new-name rules. */
	private WriteResult recreate(ApiPath path, byte[] bytes, Author author, @Nullable String origin)
			throws IOException {
		List<String> folders = ensureParentFolders(path);
		this.batcher.prepareWrite(author);
		try {
			this.fs.createExclusive(path.disk(), bytes);
		}
		catch (FileAlreadyExistsException ex) {
			// Appeared on disk between the checks (an external create): report it like any other conflict.
			this.reconciler.reconcileLocked(path);
			byte[] disk = this.fs.readBytes(path.disk());
			throw conflict(path, disk, Hashing.blobId(disk));
		}
		FileEntry entry = indexWritten(path, bytes);
		this.batcher.markDirty(path, author);
		publishFolders(folders, origin);
		this.hub.publish(FileEvent.created(entry, origin));
		logger.info("RECREATE {} client={}", entry.path(), origin);
		return new WriteResult(entry, true, folders);
	}

	private VersionConflictException conflict(ApiPath path, byte[] disk, String current) {
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		Instant mtime = (attributes != null) ? attributes.lastModifiedTime().toInstant() : null;
		return new VersionConflictException(path.nfc(), current, TextCodec.decode(disk).text(), mtime, null);
	}

	// ---------------------------------------------------------------- raw

	/** {@code GET /api/files/raw}: any indexed file, never a symlink; side-effect free like {@link #readText}. */
	public RawFile openRaw(String apiPath) {
		ApiPath path = this.paths.resolveForRead(apiPath);
		requireFile(path);
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		if (attributes == null || !attributes.isRegularFile()) {
			throw NotesException.notFound(path.nfc());
		}
		return new RawFile(path, this.fs.resolve(path.disk()), attributes.size(),
				attributes.lastModifiedTime().toInstant());
	}

	/**
	 * {@code PUT /api/files/raw}: the body is streamed to a temp file before any lock is taken, so a slow upload never
	 * blocks saves; only the final link or rename happens under the locks.
	 */
	public Saved upload(String apiPath, UploadConflict onConflict, InputStream body, long contentLength,
			Identity identity, @Nullable String origin) throws IOException {
		ApiPath path = uploadTarget(apiPath, onConflict);
		if (contentLength > this.maxUploadSize) {
			throw NotesException.tooLarge(this.maxUploadSize, "Uploads are limited to " + this.maxUploadSize + " bytes");
		}
		if (contentLength >= 0 && this.fs.usableSpace() - contentLength < this.minFreeSpace) {
			throw NotesException.insufficientStorage(this.minFreeSpace);
		}
		Path tmp = this.fs.writeTemp(body, this.maxUploadSize);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			if (this.fs.usableSpace() < this.minFreeSpace) {
				throw NotesException.insufficientStorage(this.minFreeSpace);
			}
			long size = Files.size(tmp);
			byte[] text = this.indexer.isIndexedText(path.nfc(), size) ? Files.readAllBytes(tmp) : null;
			Author author = Author.of(identity);
			if (onConflict == UploadConflict.OVERWRITE) {
				try (VaultLocks.Held held = this.locks.read(lockPaths(path))) {
					FileRecord existing = existingLocked(path);
					if (existing != null) {
						return new Saved(overwrite(path, existing, tmp, author, origin), false);
					}
				}
			}
			if (this.index.isFolder(path.nfc())) {
				throw NotesException.typeMismatch(path.nfc(), "file", "A folder exists at " + path.nfc());
			}
			try (Created created = createNew(path, onConflict == UploadConflict.RENAME,
					(target) -> this.fs.createExclusiveFrom(tmp, target.disk()), author)) {
				FileEntry entry = (text != null) ? indexWritten(created.target(), text)
						: indexFromDisk(created.target());
				this.batcher.markDirty(created.target(), author);
				publishFolders(created.createdFolders(), origin);
				this.hub.publish(FileEvent.created(entry, origin));
				logger.info("UPLOAD {} client={} user={} {} bytes", entry.path(), origin, identity.login(), size);
				return new Saved(new WriteResult(entry, true, created.createdFolders()), true);
			}
		}
		finally {
			Files.deleteIfExists(tmp);
		}
	}

	private WriteResult overwrite(ApiPath path, FileRecord existing, Path tmp, Author author, @Nullable String origin)
			throws IOException {
		if (existing.kind().isText()) {
			throw NotesException.badRequest("Text files are saved with PUT /api/files, which detects conflicts");
		}
		preserve(path);
		boolean kept = keepReplacedVersion(path, author.email());
		this.batcher.prepareWrite(author);
		this.fs.replaceFrom(tmp, path.disk());
		FileEntry entry = indexFromDisk(path);
		this.batcher.markDirty(path, author);
		this.hub.publish(FileEvent.changed(entry, origin));
		if (kept) {
			this.hub.publish(new TrashChangedEvent());
		}
		logger.info("UPLOAD (overwrite) {} client={}", entry.path(), origin);
		return new WriteResult(entry, false, List.of());
	}

	/** An overwrite addresses an existing file (any existing name works); everything else introduces a new name. */
	private ApiPath uploadTarget(String apiPath, UploadConflict onConflict) {
		if (onConflict == UploadConflict.OVERWRITE) {
			try {
				ApiPath existing = this.paths.resolve(apiPath, Mode.EXISTING);
				if (this.index.file(existing.nfc()) != null) {
					return existing;
				}
			}
			catch (NotesException ex) {
				// Not addressable as an existing path; validate it as a new name below.
			}
		}
		return this.paths.resolve(apiPath, Mode.NEW);
	}

	// ---------------------------------------------------------------- building blocks

	/**
	 * <em>Preserve before overwrite</em>: makes sure the content on disk (including an external edit the watcher has
	 * not reconciled yet) is committed before it is replaced. Called under the caller's locks.
	 * @throws NotesException {@code 503 history-unavailable} ({@code commit-failed}) when git is enabled and the
	 * commit fails; nothing may be written then
	 */
	public void preserve(ApiPath path) throws IOException {
		reconcileIfStale(path);
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			throw NotesException.historyUnavailable("commit-failed",
					"The current version could not be saved to history, so nothing was overwritten");
		}
	}

	/**
	 * Keeps the version an overwrite or a history restore is about to replace when git cannot bring it back: a file
	 * larger than the large-file threshold is not in history (DESIGN §5.8), so a copy of it goes to the trash first.
	 * Called under the caller's locks, after {@link #preserve}. Returns true when a copy was kept; the caller then
	 * publishes {@code trash.changed} after its content event.
	 */
	public boolean keepReplacedVersion(ApiPath path, String login) throws IOException {
		LargeFiles.Entry large = this.largeFiles.entry(path.nfc());
		if (large == null) {
			return false;
		}
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		if (attributes == null || !attributes.isRegularFile()) {
			return false;
		}
		TrashStore.Item item = this.trashStore.locked(
				() -> this.trashStore.keepCopy(path.disk(), path.nfc(), login, attributes.size()));
		logger.info("KEEP {} in the trash as {} before it is replaced (larger than {}, not in history)", path.nfc(),
				item.trashPath(), this.largeFiles.describeLimit());
		return true;
	}

	/** Like {@link #preserve}, but a commit failure is only logged (stale saves, deletes). */
	public void preserveQuietly(ApiPath path) throws IOException {
		reconcileIfStale(path);
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			logger.warn("Could not commit {} before continuing: {}", path.nfc(), ex.getMessage());
		}
	}

	private void reconcileIfStale(ApiPath path) throws IOException {
		FileRecord record = this.index.file(path.nfc());
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		if (record == null || attributes == null || !attributes.isRegularFile()) {
			if (record != null || attributes != null) {
				this.reconciler.reconcileLocked(path);
			}
			return;
		}
		boolean stale;
		if (this.indexer.isIndexedText(path.nfc(), attributes.size())) {
			stale = !Hashing.blobId(this.fs.readBytes(path.disk())).equals(record.version());
		}
		else {
			stale = record.size() != attributes.size()
					|| !record.mtime().equals(attributes.lastModifiedTime().toInstant());
		}
		if (stale) {
			this.reconciler.reconcileLocked(path);
		}
	}

	/** A file {@link #createLocked} made, and the folders it created for it (outermost first). */
	public record NewFile(FileEntry entry, List<String> createdFolders) {
	}

	/**
	 * Creates a new file for a caller that holds the vault read lock and the locks of {@code path} and its ancestors
	 * ({@link #lockPaths}), and that writes other files in the same operation (the task API). Like {@code POST
	 * /api/files} it never replaces anything: {@code already-exists} or {@code case-collision} when the name is
	 * taken, even by a file created outside the app a moment ago. The file is indexed and queued for git; the caller
	 * publishes {@code folder.created} and {@code file.created} before releasing its locks.
	 */
	public NewFile createLocked(ApiPath path, byte[] bytes, Author author) throws IOException {
		requireWithinTextLimit(path, bytes.length);
		checkFree(path);
		List<String> folders = ensureParentFolders(path);
		this.batcher.prepareWrite(author);
		try {
			this.fs.createExclusive(path.disk(), bytes);
		}
		catch (FileAlreadyExistsException ex) {
			this.reconciler.reconcileLocked(path);
			throw NotesException.alreadyExists(path.nfc(), path.nfc());
		}
		FileEntry entry = indexWritten(path, bytes);
		this.batcher.markDirty(path, author);
		return new NewFile(entry, folders);
	}

	/**
	 * Creates the missing parent folders of {@code path} on disk and in the index. Returns the folders that are new to
	 * the index, outermost first; the caller publishes {@code folder.created} for them before its file event.
	 */
	public List<String> ensureParentFolders(ApiPath path) throws IOException {
		return ensureFolder(path.parent(), PathNames.parentOf(path.disk()), path.nfc());
	}

	/** Creates {@code folder} and its missing ancestors; see {@link #ensureParentFolders}. */
	public List<String> ensureFolder(String folder, String folderDisk, String forPath) throws IOException {
		if (folder.isEmpty() || this.index.isFolder(folder)) {
			return List.of();
		}
		String[] segments = folder.split("/");
		String[] diskSegments = folderDisk.split("/");
		List<String> created = new ArrayList<>();
		StringBuilder current = new StringBuilder();
		StringBuilder currentDisk = new StringBuilder();
		for (int i = 0; i < segments.length; i++) {
			if (i > 0) {
				current.append('/');
				currentDisk.append('/');
			}
			current.append(segments[i]);
			currentDisk.append((diskSegments.length == segments.length) ? diskSegments[i] : segments[i]);
			String prefix = current.toString();
			if (this.index.isFolder(prefix)) {
				continue;
			}
			String file = this.index.fileIgnoreCase(prefix);
			if (file != null) {
				throw NotesException.typeMismatch(forPath, "folder", "A parent of " + forPath + " is a file: " + file);
			}
			try {
				this.fs.createDirectory(currentDisk.toString());
			}
			catch (FileAlreadyExistsException ex) {
				throw NotesException.typeMismatch(forPath, "folder", "A parent of " + forPath + " is a file: " + prefix);
			}
			created.addAll(this.index.addFolder(prefix, currentDisk.toString()));
		}
		return created;
	}

	/** Indexes bytes just written to {@code path} (parsing outside the index lock) and returns the tree entry. */
	public FileEntry indexWritten(ApiPath path, byte[] bytes) throws IOException {
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		if (attributes == null) {
			throw new NoSuchFileException(path.disk());
		}
		return this.index.put(this.indexer.fromBytes(path.nfc(), path.disk(), bytes, attributes));
	}

	/** Indexes a file from disk (used for binary files, which are described by size and mtime). */
	public FileEntry indexFromDisk(ApiPath path) throws IOException {
		return this.index.put(this.indexer.load(path.nfc(), path.disk()));
	}

	public void publishFolders(List<String> folders, @Nullable String origin) {
		folders.forEach((folder) -> this.hub.publish(new FolderEvent(folder, origin)));
	}

	/** The path and all its ancestors: locked together so folder creation and the file write cannot interleave. */
	public static List<String> lockPaths(ApiPath path) {
		List<String> lockPaths = new ArrayList<>();
		lockPaths.add(path.nfc());
		for (String parent = path.parent(); !parent.isEmpty(); parent = PathNames.parentOf(parent)) {
			lockPaths.add(parent);
		}
		return lockPaths;
	}

	/**
	 * The indexed record of {@code path}, reconciling inline on an index miss (the file may have just appeared
	 * externally). Call under the path lock.
	 */
	public @Nullable FileRecord existingLocked(ApiPath path) {
		FileRecord record = this.index.file(path.nfc());
		if (record == null && !this.index.isFolder(path.nfc())) {
			this.reconciler.reconcileLocked(path);
			record = this.index.file(path.nfc());
		}
		return record;
	}

	// ---------------------------------------------------------------- internals

	/**
	 * Picks the target and creates it without ever replacing a file: fail mode reports any existing entry or case
	 * variant; rename mode tries {@code " 1"} to {@code " 999"}, each candidate under its own path lock.
	 */
	private Created createNew(ApiPath path, boolean rename, Creator creator, Author author) throws IOException {
		List<String> folders = new ArrayList<>();
		int next = 0;
		while (true) {
			// Pick a candidate without locks, then take the vault lock, the path, its ancestors and the candidate in
			// one sorted acquisition, and re-check under them. Locking a candidate while already holding other
			// stripes could deadlock against a concurrent create.
			int n = rename ? nextFreeCandidate(path, next) : 0;
			if (n > NameRules.MAX_SUFFIX) {
				throw NotesException.alreadyExists(path.nfc(), withSuffix(path, NameRules.MAX_SUFFIX).nfc());
			}
			ApiPath candidate = (n == 0) ? path : withSuffix(path, n);
			List<String> lockPaths = lockPaths(path);
			lockPaths.add(candidate.nfc());
			VaultLocks.Held held = this.locks.read(lockPaths);
			boolean keep = false;
			try {
				if (!rename) {
					checkFree(candidate);
				}
				else if (isTaken(candidate.nfc())) {
					next = n + 1;
					continue;
				}
				folders.addAll(ensureParentFolders(candidate));
				this.batcher.prepareWrite(author);
				try {
					creator.create(candidate);
				}
				catch (FileAlreadyExistsException ex) {
					// Created on disk by someone else (perhaps outside the app) since the index was checked.
					this.reconciler.reconcileLocked(candidate);
					if (!rename) {
						throw NotesException.alreadyExists(candidate.nfc(), candidate.nfc());
					}
					next = n + 1;
					continue;
				}
				keep = true;
				return new Created(candidate, folders, held);
			}
			finally {
				if (!keep) {
					held.close();
				}
			}
		}
	}

	/** The first suffix number at or after {@code from} whose name is free in the index (0 is the name itself). */
	private int nextFreeCandidate(ApiPath path, int from) {
		int n = from;
		while (n <= NameRules.MAX_SUFFIX && isTaken(((n == 0) ? path : withSuffix(path, n)).nfc())) {
			n++;
		}
		return n;
	}

	private void checkFree(ApiPath path) {
		String nfc = path.nfc();
		if (this.index.file(nfc) != null || this.index.isFolder(nfc)) {
			throw NotesException.alreadyExists(nfc, nfc);
		}
		String file = this.index.fileIgnoreCase(nfc);
		if (file != null) {
			throw NotesException.caseCollision(nfc, file);
		}
		String folder = this.index.folderIgnoreCase(nfc);
		if (folder != null) {
			throw NotesException.caseCollision(nfc, folder);
		}
	}

	private boolean isTaken(String nfc) {
		return this.index.file(nfc) != null || this.index.isFolder(nfc) || this.index.fileIgnoreCase(nfc) != null
				|| this.index.folderIgnoreCase(nfc) != null;
	}

	private static ApiPath withSuffix(ApiPath path, int n) {
		String name = NameRules.withSuffix(path.name(), n);
		return new ApiPath(PathNames.join(path.parent(), name), PathNames.join(PathNames.parentOf(path.disk()), name));
	}

	/** The indexed file for a read; the index decides what is visible, without touching it. */
	private FileRecord requireFile(ApiPath path) {
		if (this.index.isFolder(path.nfc())) {
			throw NotesException.typeMismatch(path.nfc(), "file", "A folder exists at " + path.nfc());
		}
		FileRecord record = this.index.file(path.nfc());
		if (record == null) {
			throw NotesException.notFound(path.nfc());
		}
		return record;
	}

	private void requireTextKind(ApiPath path) {
		FileKind kind = this.kinds.kindOf(path.nfc());
		if (!kind.isText()) {
			throw NotesException.notText(path.nfc(), kind.wireName());
		}
	}

	private void requireWithinTextLimit(ApiPath path, long size) {
		long limit = this.kinds.textLimit(path.nfc());
		if (size > limit) {
			throw NotesException.tooLarge(limit, "Text files are limited to " + limit + " bytes");
		}
	}

	private byte @Nullable [] readOrNull(ApiPath path) throws IOException {
		try {
			return this.fs.readBytes(path.disk());
		}
		catch (NoSuchFileException ex) {
			this.reconciler.reconcileLocked(path);
			return null;
		}
	}

	private FileEntry currentEntry(ApiPath path) {
		FileRecord record = this.index.file(path.nfc());
		if (record == null) {
			throw NotesException.notFound(path.nfc());
		}
		return record.toEntry();
	}

}
