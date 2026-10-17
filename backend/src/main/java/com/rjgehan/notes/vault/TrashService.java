package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.RestoreRequest;
import com.rjgehan.notes.api.dto.RestoreResult;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileDeletedEvent;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.FolderDeletedEvent;
import com.rjgehan.notes.events.ResyncEvent;
import com.rjgehan.notes.events.TrashChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.CommitFailedException;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.index.VaultWalk;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Delete to trash, listing, restore, purge and empty (DESIGN §5.7). Content deleted through the app is committed to
 * git before it moves to the trash, and the trash itself is never committed.
 */
@Service
public class TrashService {

	private static final Logger logger = LoggerFactory.getLogger(TrashService.class);

	/** Above this many restored files, one {@code resync} replaces the per-file events. */
	static final int BULK_THRESHOLD = 50;

	private final VaultPaths paths;

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final TrashStore store;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	public TrashService(VaultPaths paths, VaultFs fs, VaultLocks locks, VaultIndex index, FileService files,
			TrashStore store, VaultReconciler reconciler, CommitBatcher batcher, EventHub hub) {
		this.paths = paths;
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.store = store;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
	}

	/** {@code DELETE /api/files}: any kind of file, including names that break the new-name rules. */
	public TrashEntry deleteFile(String apiPath, Identity identity, @Nullable String origin) throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.read(FileService.lockPaths(path))) {
			FileRecord record = (this.index.isFolder(path.nfc())) ? null : this.files.existingLocked(path);
			if (record == null) {
				if (this.index.isFolder(path.nfc())) {
					throw NotesException.typeMismatch(path.nfc(), "file",
							"Folders are deleted with DELETE /api/folders: " + path.nfc());
				}
				throw NotesException.notFound(path.nfc());
			}
			// The last content, including an external edit not reconciled yet, goes to git; it survives in the
			// trash anyway, so a failed commit does not stop the delete.
			this.files.preserveQuietly(path);
			FileRecord current = this.index.file(path.nfc());
			if (current == null) {
				throw NotesException.notFound(path.nfc());
			}
			TrashStore.Item item;
			try {
				item = this.store.locked(() -> this.store.trash(path.disk(), path.nfc(), EntryType.FILE,
						identity.login(), current.size(), 1));
			}
			catch (NoSuchFileException ex) {
				this.reconciler.reconcileLocked(path);
				throw NotesException.notFound(path.nfc());
			}
			this.index.removeFile(path.nfc());
			this.batcher.commitNow("Delete " + path.nfc(), null, Author.of(identity), List.of(path));
			this.hub.publish(new FileDeletedEvent(path.nfc(), true, item.id(), origin));
			this.hub.publish(new TrashChangedEvent());
			logger.info("DELETE {} trash={} client={} user={}", path.nfc(), item.trashPath(), origin,
					identity.login());
			return item.toEntry();
		}
	}

	/** {@code DELETE /api/folders}: the folder and everything in it become one trash entry. */
	public TrashEntry deleteFolder(String apiPath, Identity identity, @Nullable String origin) throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.write()) {
			if (!this.index.isFolder(path.nfc()) && this.index.file(path.nfc()) == null) {
				this.reconciler.reconcileLocked(path);
			}
			if (this.index.file(path.nfc()) != null) {
				throw NotesException.typeMismatch(path.nfc(), "folder",
						"Files are deleted with DELETE /api/files: " + path.nfc());
			}
			if (!this.index.isFolder(path.nfc())) {
				throw NotesException.notFound(path.nfc());
			}
			// Index (and queue for git) external edits inside the folder, then commit them before the folder leaves.
			this.reconciler.reconcileLocked(path);
			flushQuietly(path);
			if (!this.index.isFolder(path.nfc())) {
				throw NotesException.notFound(path.nfc());
			}
			List<FileRecord> contents = this.index.filesUnder(path.nfc());
			long size = contents.stream().mapToLong(FileRecord::size).sum();
			int count = contents.size();
			TrashStore.Item item = this.store.locked(() -> this.store.trash(path.disk(), path.nfc(),
					EntryType.FOLDER, identity.login(), size, count));
			this.index.removeFolder(path.nfc());
			if (count > 0) {
				this.batcher.commitNow(
						"Delete folder " + path.nfc() + " (" + count + ((count == 1) ? " file)" : " files)"), null,
						Author.of(identity), List.of(path));
			}
			this.hub.publish(new FolderDeletedEvent(path.nfc(), true, item.id(), origin));
			this.hub.publish(new TrashChangedEvent());
			logger.info("DELETE folder {} files={} trash={} client={} user={}", path.nfc(), count, item.trashPath(),
					origin, identity.login());
			return item.toEntry();
		}
	}

	/** {@code GET /api/trash}: newest first. */
	public List<TrashEntry> list() throws IOException {
		return this.store.locked(() -> this.store.list().stream().map(TrashStore.Item::toEntry).toList());
	}

	/** {@code GET /api/trash/{id}/raw}: a trashed file; folders and symlinks are refused. */
	public FileService.RawFile openRaw(String id) throws IOException {
		TrashStore.Item item = this.store.locked(() -> this.store.find(id));
		if (item == null) {
			throw notFound(id);
		}
		if (item.type() == EntryType.FOLDER) {
			throw NotesException.typeMismatch(item.originalPath(), "file", "Trashed folders cannot be previewed");
		}
		BasicFileAttributes attributes = this.fs.attributes(item.disk());
		if (attributes == null || !attributes.isRegularFile()) {
			throw notFound(id);
		}
		return new FileService.RawFile(ApiPath.of(item.originalPath()), this.fs.resolve(item.disk()),
				attributes.size(), attributes.lastModifiedTime().toInstant());
	}

	/**
	 * {@code POST /api/trash/{id}/restore}: back to the original path (the name existed, so the new-name rules do not
	 * apply) or to an explicit {@code to} (a new name). Links to the restored files resolve again.
	 */
	public RestoreResult restore(String id, @Nullable RestoreRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		OnConflict onConflict = (request != null && request.onConflict() != null) ? request.onConflict()
				: OnConflict.FAIL;
		String to = (request != null) ? request.to() : null;
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.write()) {
			Restored restored = this.store.locked(() -> {
				TrashStore.Item item = this.store.find(id);
				BasicFileAttributes attributes = (item != null) ? this.fs.attributes(item.disk()) : null;
				if (item == null || attributes == null || attributes.isSymbolicLink() || attributes.isOther()) {
					throw notFound(id);
				}
				ApiPath requested = (to != null) ? this.paths.resolve(to, Mode.NEW)
						: this.paths.resolve(item.originalPath(), Mode.RESTORE);
				ApiPath target = freeTarget(requested, item.type(), onConflict == OnConflict.RENAME);
				List<String> parents = this.files.ensureParentFolders(target);
				try {
					if (item.type() == EntryType.FILE) {
						this.fs.moveExclusive(item.disk(), target.disk());
					}
					else {
						this.fs.moveDirectory(item.disk(), target.disk());
					}
				}
				catch (FileAlreadyExistsException ex) {
					this.files.publishFolders(parents, origin);
					throw NotesException.alreadyExists(target.nfc(), target.nfc());
				}
				this.store.forget(item);
				return new Restored(item, target, parents);
			});
			return finishRestore(restored, identity, origin);
		}
	}

	private record Restored(TrashStore.Item item, ApiPath target, List<String> parents) {
	}

	private RestoreResult finishRestore(Restored restored, Identity identity, @Nullable String origin)
			throws IOException {
		ApiPath target = restored.target();
		List<String> folders = new ArrayList<>(restored.parents());
		List<FileEntry> entries = new ArrayList<>();
		if (restored.item().type() == EntryType.FILE) {
			entries.add(this.files.indexFromDisk(target));
		}
		else {
			folders.addAll(this.index.addFolder(target.nfc(), target.disk()));
			VaultWalk.Result walk = VaultWalk.walk(this.fs, target.nfc(), target.disk());
			for (VaultWalk.FoundFolder folder : walk.folders()) {
				folders.addAll(this.index.addFolder(folder.path(), folder.disk()));
			}
			for (VaultWalk.FoundFile file : walk.files()) {
				entries.add(this.files.indexFromDisk(new ApiPath(file.path(), file.disk())));
			}
		}
		GitStore.Commit commit = this.batcher.commitNow("Restore " + target.nfc() + " from trash", null,
				Author.of(identity), List.of(target));
		if (entries.size() > BULK_THRESHOLD) {
			this.hub.publish(new ResyncEvent(ResyncEvent.Reason.BULK_CHANGE));
		}
		else {
			this.files.publishFolders(folders, origin);
			entries.forEach((entry) -> this.hub.publish(FileEvent.created(entry, origin)));
		}
		this.hub.publish(new TrashChangedEvent());
		logger.info("RESTORE {} from trash files={} client={} user={}", target.nfc(), entries.size(), origin,
				identity.login());
		return new RestoreResult(restored.item().type(), target.nfc(), entries, folders,
				(commit != null) ? commit.id() : null);
	}

	/**
	 * The requested path, or with {@code rename} the first free name with {@code " 1"} to {@code " 999"}; a taken name
	 * (exactly, by case, or on disk without being indexed yet) is a 409 otherwise.
	 */
	private ApiPath freeTarget(ApiPath requested, EntryType type, boolean rename) {
		for (int n = 0; n <= NameRules.MAX_SUFFIX; n++) {
			ApiPath candidate = (n == 0) ? requested : withSuffix(requested, n, type);
			List<String> variants = this.index.caseVariants(candidate.nfc());
			boolean onDisk = this.fs.attributes(candidate.disk()) != null;
			if (variants.isEmpty() && !onDisk) {
				return candidate;
			}
			if (!rename) {
				if (variants.isEmpty() || variants.contains(candidate.nfc())) {
					throw NotesException.alreadyExists(candidate.nfc(), candidate.nfc());
				}
				throw NotesException.caseCollision(candidate.nfc(), variants.get(0));
			}
		}
		throw NotesException.alreadyExists(requested.nfc(), requested.nfc());
	}

	private static ApiPath withSuffix(ApiPath path, int n, EntryType type) {
		String name = (type == EntryType.FILE) ? NameRules.withSuffix(path.name(), n) : path.name() + " " + n;
		return new ApiPath(PathNames.join(path.parent(), name), PathNames.join(PathNames.parentOf(path.disk()), name));
	}

	/**
	 * {@code DELETE /api/trash/{id}}. Under the locks the item only leaves the trash (a rename); it is deleted after
	 * they are released, so purging a large folder never makes deletes and trash listings wait (DESIGN §5.4).
	 */
	public void purge(String id) throws IOException {
		Optional<Path> staged;
		try (VaultLocks.Held held = this.locks.read()) {
			staged = this.store.locked(() -> {
				TrashStore.Item item = this.store.find(id);
				if (item == null) {
					throw notFound(id);
				}
				Path path = this.store.purge(item);
				logger.info("PURGE {} ({})", item.trashPath(), item.id());
				return Optional.ofNullable(path);
			});
			this.hub.publish(new TrashChangedEvent());
		}
		staged.ifPresent(this::deleteStaged);
	}

	/** {@code DELETE /api/trash}: returns how many entries were deleted. Deletes after the locks, like purge. */
	public int empty() throws IOException {
		TrashStore.Emptied emptied;
		try (VaultLocks.Held held = this.locks.read()) {
			emptied = this.store.locked(this.store::empty);
			if (emptied.count() > 0) {
				this.hub.publish(new TrashChangedEvent());
			}
			logger.info("EMPTY trash purged={}", emptied.count());
		}
		emptied.staged().forEach(this::deleteStaged);
		return emptied.count();
	}

	private void deleteStaged(Path staged) {
		try {
			this.fs.deleteRecursively(staged);
		}
		catch (IOException ex) {
			logger.warn("Could not finish deleting a purged trash item ({}); it is removed at the next start: {}",
					staged.getFileName(), ex.toString());
		}
	}

	private void flushQuietly(ApiPath path) {
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			logger.warn("Could not commit {} before deleting it: {}", path.nfc(), ex.getMessage());
		}
	}

	private static NotesException notFound(String id) {
		return new NotesException(ErrorCode.NOT_FOUND, "No such trash entry: " + id, Map.of());
	}

}
