package com.rjgehan.notes.history;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.HistoryContent;
import com.rjgehan.notes.api.dto.HistoryExclusion;
import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.api.dto.HistoryResponse;
import com.rjgehan.notes.api.dto.HistoryRestoreRequest;
import com.rjgehan.notes.api.dto.HistoryRestoreResult;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.TrashChangedEvent;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.MoveLog;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.vault.VaultLocks;
import com.rjgehan.notes.vault.VaultPaths;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import org.eclipse.jgit.revwalk.RevCommit;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * The history API (API.md §14): per-file log following renames, old versions, restore and "commit now". Every
 * operation answers {@code 503 history-unavailable} while git is disabled, unusable, or still importing.
 */
@Service
public class HistoryService {

	private static final Logger logger = LoggerFactory.getLogger(HistoryService.class);

	private static final Pattern COMMIT_ID = Pattern.compile("[0-9a-fA-F]{40}");

	/** A blob to serve raw. */
	public record RawBlob(String name, String blobId, long size) {
	}

	private final GitStore git;

	private final CommitBatcher batcher;

	private final VaultPaths paths;

	private final VaultIndex index;

	private final VaultLocks locks;

	private final VaultFs fs;

	private final FileKinds kinds;

	private final FileService files;

	private final MoveLog moveLog;

	private final EventHub hub;

	private final LargeFiles largeFiles;

	public HistoryService(GitStore git, CommitBatcher batcher, VaultPaths paths, VaultIndex index, VaultLocks locks,
			VaultFs fs, FileKinds kinds, FileService files, MoveLog moveLog, EventHub hub, LargeFiles largeFiles) {
		this.git = git;
		this.batcher = batcher;
		this.largeFiles = largeFiles;
		this.paths = paths;
		this.index = index;
		this.locks = locks;
		this.fs = fs;
		this.kinds = kinds;
		this.files = files;
		this.moveLog = moveLog;
		this.hub = hub;
	}

	/**
	 * {@code GET /api/history}: newest first, with each commit's path as of that commit. A file over the large-file
	 * threshold is marked {@code excluded}; it never has pending changes, since none of them will be committed.
	 */
	public HistoryResponse list(String apiPath, int limit, int offset) throws IOException {
		requireAvailable();
		String path = this.paths.normalize(apiPath);
		String disk = this.index.diskPath(path);
		if (disk == null) {
			disk = this.git.diskPathAtHead(path);
		}
		GitStore.LogPage page = this.git.log((disk != null) ? disk : path, offset, limit);
		List<HistoryEntry> entries = new ArrayList<>(page.entries().size());
		for (GitStore.LogEntry entry : page.entries()) {
			RevCommit commit = entry.commit();
			var author = commit.getAuthorIdent();
			entries.add(new HistoryEntry(commit.name(), commit.abbreviate(7).name(), entry.parentId(), entry.path(),
					author.getWhenAsInstant(), author.getName(), author.getEmailAddress(), commit.getShortMessage(),
					entry.change(), entry.renamedFrom()));
		}
		LargeFiles.Entry large = this.largeFiles.entry(path);
		HistoryExclusion excluded = (large != null)
				? new HistoryExclusion(HistoryExclusion.Reason.LARGE_FILE, large.size(), this.largeFiles.limit())
				: null;
		return new HistoryResponse(path, excluded == null && this.batcher.isPending(path), page.hasMore(), entries,
				excluded);
	}

	/** {@code GET /api/history/content}: decoded text for text kinds; {@code binary} for the others. */
	public HistoryContent content(String apiPath, String commitId) throws IOException {
		requireAvailable();
		String commit = requireCommitId(commitId);
		String path = this.paths.normalize(apiPath);
		GitStore.BlobInfo info = this.git.blobAt(commit, path);
		if (info == null) {
			throw NotesException.notFound(path);
		}
		FileKind kind = this.kinds.kindOf(path);
		if (!kind.isText()) {
			return new HistoryContent(commit, path, info.id(), info.size(), true, null, false);
		}
		long limit = this.kinds.textLimit(path);
		if (info.size() > limit) {
			throw NotesException.tooLarge(limit, "This version is larger than the text limit; download it raw instead");
		}
		byte[] bytes;
		try (InputStream in = this.git.open(info.id())) {
			bytes = in.readAllBytes();
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		return new HistoryContent(commit, path, info.id(), bytes.length, false, decoded.text(), decoded.lossy());
	}

	/** {@code GET /api/history/raw}: the blob at that commit, streamed. */
	public RawBlob raw(String apiPath, String commitId) throws IOException {
		requireAvailable();
		String commit = requireCommitId(commitId);
		String path = this.paths.normalize(apiPath);
		GitStore.BlobInfo info = this.git.blobAt(commit, path);
		if (info == null) {
			throw NotesException.notFound(path);
		}
		return new RawBlob(PathNames.nameOf(path), info.id(), info.size());
	}

	public InputStream openBlob(String blobId) throws IOException {
		return this.git.open(blobId);
	}

	/**
	 * {@code POST /api/history/restore}: commits the current content and pending edits first (so nothing is
	 * overwritten unseen), writes the historical bytes verbatim, and commits the restore immediately.
	 */
	public HistoryRestoreResult restore(HistoryRestoreRequest request, Identity identity, @Nullable String origin)
			throws IOException {
		requireAvailable();
		String commit = requireCommitId(request.commit());
		ApiPath path = this.paths.resolve(request.path(), Mode.EXISTING);
		String source = (request.sourcePath() != null) ? this.paths.normalize(request.sourcePath()) : path.nfc();
		GitStore.BlobInfo blob = this.git.blobAt(commit, source);
		if (blob == null) {
			throw NotesException.notFound(source);
		}
		FileKind kind = this.kinds.kindOf(path.nfc());
		Author author = Author.of(identity);
		// Text within its limit is restored from memory and indexed from those bytes. Anything else, a video for
		// example, is streamed to a temp file before any lock is taken and never held in the heap.
		byte[] bytes = null;
		Path staged = null;
		try (InputStream in = this.git.open(blob.id())) {
			if (kind.isText() && blob.size() <= this.kinds.textLimit(path.nfc())) {
				bytes = in.readAllBytes();
			}
			else {
				staged = this.fs.writeTemp(in, Long.MAX_VALUE);
			}
		}
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.read(FileService.lockPaths(path))) {
			if (this.index.isFolder(path.nfc())) {
				throw NotesException.typeMismatch(path.nfc(), "file", "A folder exists at " + path.nfc());
			}
			FileRecord existing = this.files.existingLocked(path);
			BasicFileAttributes attributes = (existing != null) ? this.fs.attributes(path.disk()) : null;
			boolean exists = attributes != null && attributes.isRegularFile();
			checkBase(path, kind, request.baseVersion(), exists);
			this.files.preserve(path);
			boolean kept = exists && this.files.keepReplacedVersion(path, identity.login());
			boolean created = !exists;
			List<String> createdFolders = created ? this.files.ensureParentFolders(path) : List.of();
			if (created) {
				try {
					if (bytes != null) {
						this.fs.createExclusive(path.disk(), bytes);
					}
					else {
						this.fs.createExclusiveFrom(staged, path.disk());
					}
				}
				catch (FileAlreadyExistsException ex) {
					throw NotesException.alreadyExists(path.nfc(), path.nfc());
				}
			}
			else if (bytes != null) {
				this.fs.atomicWrite(path.disk(), bytes);
			}
			else {
				this.fs.replaceFrom(staged, path.disk());
			}
			FileEntry entry = (bytes != null) ? this.files.indexWritten(path, bytes) : this.files.indexFromDisk(path);
			GitStore.Commit restore = this.batcher.commitNow(
					"Restore " + path.nfc() + " to version " + commit.substring(0, 7), null, author, List.of(path));
			this.files.publishFolders(createdFolders, origin);
			this.hub.publish(created ? FileEvent.created(entry, origin) : FileEvent.changed(entry, origin));
			if (kept) {
				this.hub.publish(new TrashChangedEvent());
			}
			String commitId;
			if (restore != null) {
				commitId = restore.id();
			}
			else {
				// Nothing changed (the version was already current), or the commit failed and stays pending.
				commitId = this.batcher.isPending(path.nfc()) ? null : this.git.head();
			}
			logger.info("RESTORE {} to {} client={} user={}", path.nfc(), commit.substring(0, 7), origin,
					identity.login());
			return new HistoryRestoreResult(entry, created, createdFolders, commitId);
		}
		finally {
			if (staged != null) {
				Files.deleteIfExists(staged);
			}
		}
	}

	/**
	 * Text kinds: {@code baseVersion} must match the file on disk, or be null when it is absent. Other kinds: it must
	 * be null, and an existing file is overwritten. The current file is read only to compare a text version, so a
	 * large binary is never loaded.
	 */
	private void checkBase(ApiPath path, FileKind kind, @Nullable String baseVersion, boolean exists)
			throws IOException {
		if (!kind.isText()) {
			if (baseVersion != null) {
				throw NotesException.badRequest("baseVersion must be null when restoring a non-text file");
			}
			return;
		}
		if (baseVersion == null) {
			if (exists) {
				throw NotesException.alreadyExists(path.nfc(), path.nfc());
			}
			return;
		}
		BasicFileAttributes attributes = exists ? this.fs.attributes(path.disk()) : null;
		long limit = this.kinds.textLimit(path.nfc());
		if (attributes != null && attributes.size() > limit) {
			throw NotesException.tooLarge(limit, "The file on the server is larger than the text limit");
		}
		byte[] disk = exists ? readOrNull(path) : null;
		if (disk == null) {
			throw new VersionConflictException(path.nfc(), null, null, null, this.moveLog.movedTo(path.nfc()));
		}
		String current = Hashing.blobId(disk);
		if (!current.equals(baseVersion)) {
			this.files.preserveQuietly(path);
			BasicFileAttributes now = this.fs.attributes(path.disk());
			throw new VersionConflictException(path.nfc(), current, TextCodec.decode(disk).text(),
					(now != null) ? now.lastModifiedTime().toInstant() : null, null);
		}
	}

	/** {@code POST /api/history/commit}: commits the pending batch now. */
	public GitStore.@Nullable Commit commitPending() {
		requireAvailable();
		try {
			return this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			throw NotesException.historyUnavailable("commit-failed", "The commit failed; the changes stay pending");
		}
	}

	private void requireAvailable() {
		if (!this.git.isEnabled()) {
			if (this.git.isDisabledByConfiguration()) {
				throw NotesException.historyUnavailable("disabled", "Git history is disabled");
			}
			throw NotesException.historyUnavailable("unusable: " + this.git.disabledReason(),
					"Git history is unavailable: " + this.git.disabledReason());
		}
		if (this.batcher.isImporting()) {
			throw NotesException.historyUnavailable("importing", "The vault is still being imported into history");
		}
	}

	private static String requireCommitId(@Nullable String commitId) {
		if (commitId == null || !COMMIT_ID.matcher(commitId).matches()) {
			throw NotesException.badRequest("commit must be a full 40-character commit id");
		}
		return commitId.toLowerCase(Locale.ROOT);
	}

	private byte @Nullable [] readOrNull(ApiPath path) throws IOException {
		try {
			return this.fs.readBytes(path.disk());
		}
		catch (NoSuchFileException ex) {
			return null;
		}
	}

}
