package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.nio.file.NoSuchFileException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.JsonConfig;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.FolderEvent;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.vault.VaultLocks;
import com.rjgehan.notes.vault.VaultPaths;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.ObjectWriter;

import org.springframework.stereotype.Component;

/**
 * How every task operation changes the vault (DESIGN §5.20): a {@link Session} takes the vault read lock and the
 * path locks of every file it may touch in one acquisition, reads those files from disk (reconciling an external edit
 * the index has not seen yet, and refusing malformed files), lets the operation edit the trees in memory, and then
 * writes the changed files atomically: new files with the no-clobber create, others with the atomic replace. Files
 * are indexed, queued for a batched commit like autosaves, and announced, all before the locks are released.
 * <p>
 * When an operation moves tasks between files, the files that gain tasks are written before the files that lose
 * them, so a failure in between leaves a duplicate (reported, nothing lost) rather than a missing task.
 */
@Component
class TaskWrites {

	private final VaultPaths paths;

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final FileKinds kinds;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final TaskStore store;

	private final Clock clock;

	private final Ulid ids;

	private final ObjectWriter writer;

	TaskWrites(VaultPaths paths, VaultFs fs, VaultLocks locks, VaultIndex index, FileService files, FileKinds kinds,
			VaultReconciler reconciler, CommitBatcher batcher, EventHub hub, TaskStore store, Clock clock) {
		this.paths = paths;
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.kinds = kinds;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
		this.store = store;
		this.clock = clock;
		this.ids = new Ulid(clock);
		this.writer = JsonConfig.vaultFileWriter(store.mapper());
	}

	/** A new ULID. */
	String newId() {
		return this.ids.next();
	}

	/** Now, truncated to milliseconds like every instant the API shows. */
	Instant now() {
		return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}

	Clock clock() {
		return this.clock;
	}

	/** A path that exists (any existing name, including one that breaks the new-name rules). */
	ApiPath existing(String path) {
		return this.paths.resolve(path, Mode.EXISTING);
	}

	/** A path the operation will create (the new-name rules apply). */
	ApiPath fresh(String path) {
		return this.paths.resolve(path, Mode.NEW);
	}

	/** The canonical bytes of a file. */
	byte[] serialize(TaskFile file) {
		return file.serialize(this.writer);
	}

	/** True when a file or folder exists at {@code path}, exactly or ignoring case. */
	boolean isTaken(ApiPath path) {
		String nfc = path.nfc();
		return this.index.file(nfc) != null || this.index.isFolder(nfc) || this.index.fileIgnoreCase(nfc) != null
				|| this.index.folderIgnoreCase(nfc) != null;
	}

	/** An operation for work that calls other services (move, trash) and publishes its own events after them. */
	CommitBatcher.Operation operation() {
		return this.batcher.beginOperation();
	}

	EventHub hub() {
		return this.hub;
	}

	/** Opens a session holding the locks of {@code files} (and of their parent folders). */
	Session open(Collection<ApiPath> files, Author author, @Nullable String origin) {
		Set<String> lockPaths = new LinkedHashSet<>();
		files.forEach((path) -> lockPaths.addAll(FileService.lockPaths(path)));
		CommitBatcher.Operation operation = this.batcher.beginOperation();
		try {
			return new Session(operation, this.locks.read(lockPaths), author, origin);
		}
		catch (RuntimeException ex) {
			operation.close();
			throw ex;
		}
	}

	static NotesException malformed(String path, String reason) {
		return new NotesException(ErrorCode.MALFORMED_FILE, path + " cannot be used: " + reason,
				Map.of("path", path, "reason", reason));
	}

	/** What a session wrote. {@code files} is empty when nothing changed on disk. */
	record Committed(List<FileEntry> files, List<String> createdFolders) {
	}

	/** One operation's locks, files and events; see {@link TaskWrites}. */
	final class Session implements AutoCloseable {

		private final CommitBatcher.Operation operation;

		private final VaultLocks.Held held;

		private final Author author;

		private final @Nullable String origin;

		private final Map<String, Open> open = new LinkedHashMap<>();

		private final List<VaultEvent> events = new ArrayList<>();

		private static final class Open {

			final ApiPath path;

			final TaskFile file;

			final byte @Nullable [] original;

			boolean touched;

			boolean losing;

			Open(ApiPath path, TaskFile file, byte @Nullable [] original) {
				this.path = path;
				this.file = file;
				this.original = original;
			}

		}

		private Session(CommitBatcher.Operation operation, VaultLocks.Held held, Author author,
				@Nullable String origin) {
			this.operation = operation;
			this.held = held;
			this.author = author;
			this.origin = origin;
		}

		@Nullable String origin() {
			return this.origin;
		}

		/**
		 * The file at {@code path} as it is on disk now, or null when there is none. An external edit the index has
		 * not seen yet is reconciled first (indexed, announced and queued as an External change), so it is committed
		 * under its own author before this operation's write.
		 * @throws NotesException {@code 409 malformed-file} when the file cannot be read as a task file or was
		 * written by a newer format version
		 */
		@Nullable TaskFile read(ApiPath path) throws IOException {
			Open known = this.open.get(path.nfc());
			if (known != null) {
				return known.file;
			}
			FileRecord record = TaskWrites.this.files.existingLocked(path);
			if (record == null) {
				return null;
			}
			byte[] bytes;
			try {
				bytes = TaskWrites.this.fs.readBytes(path.disk());
			}
			catch (NoSuchFileException ex) {
				TaskWrites.this.reconciler.reconcileLocked(path);
				return null;
			}
			if (!Hashing.blobId(bytes).equals(record.version())) {
				TaskWrites.this.reconciler.reconcileLocked(path);
			}
			long limit = TaskWrites.this.kinds.textLimit(path.nfc());
			if (bytes.length > limit) {
				throw malformed(path.nfc(), "larger than the text limit of " + limit + " bytes");
			}
			TaskFile file;
			try {
				file = TaskFile.parse(bytes, TaskWrites.this.store.mapper());
			}
			catch (TaskFile.MalformedException ex) {
				throw malformed(path.nfc(), ex.getMessage());
			}
			if (file.formatVersion() > TaskFile.FORMAT_VERSION) {
				throw malformed(path.nfc(), "written by a newer version of NotesApp; this version only reads it");
			}
			this.open.put(path.nfc(), new Open(path, file, bytes));
			return file;
		}

		/** Like {@link #read}, but a missing file is {@code 404 not-found}. */
		TaskFile require(ApiPath path) throws IOException {
			TaskFile file = read(path);
			if (file == null) {
				throw NotesException.notFound(path.nfc());
			}
			return file;
		}

		/** A file this session creates; it must not exist when the session commits. */
		void create(ApiPath path, TaskFile file) {
			Open created = new Open(path, file, null);
			created.touched = true;
			this.open.put(path.nfc(), created);
		}

		/** Marks a file as changed (edited, or gaining tasks). */
		void touch(TaskFile file) {
			find(file).touched = true;
		}

		/** Marks a file as losing tasks to another file: it is written last. */
		void touchLosing(TaskFile file) {
			Open entry = find(file);
			entry.touched = true;
			entry.losing = true;
		}

		/** An event announced after the file events, only when something was written. */
		void publish(VaultEvent event) {
			this.events.add(event);
		}

		/** The vault path of a file read or created in this session. */
		String pathOf(TaskFile file) {
			return find(file).path.nfc();
		}

		/**
		 * Writes every changed file (unchanged bytes are not written), then announces {@code folder.created},
		 * {@code file.created} or {@code file.changed} for each, then the operation's own events.
		 * @throws NotesException {@code 413 too-large} (before anything is written) when a file would exceed its
		 * text limit
		 */
		Committed commit() throws IOException {
			List<Open> pending = new ArrayList<>();
			Map<Open, byte[]> bytes = new LinkedHashMap<>();
			for (Open entry : this.open.values()) {
				if (!entry.touched) {
					continue;
				}
				byte[] serialized = serialize(entry.file);
				long limit = TaskWrites.this.kinds.textLimit(entry.path.nfc());
				if (serialized.length > limit) {
					throw NotesException.tooLarge(limit,
							entry.path.nfc() + " would be larger than the text limit of " + limit + " bytes");
				}
				if (entry.original != null && Arrays.equals(serialized, entry.original)) {
					continue;
				}
				pending.add(entry);
				bytes.put(entry, serialized);
			}
			pending.sort((a, b) -> Boolean.compare(a.losing, b.losing));
			List<FileEntry> written = new ArrayList<>();
			List<String> createdFolders = new ArrayList<>();
			List<VaultEvent> fileEvents = new ArrayList<>();
			boolean complete = false;
			try {
				for (Open entry : pending) {
					byte[] content = bytes.get(entry);
					FileEntry fileEntry;
					if (entry.original == null) {
						FileService.NewFile created = TaskWrites.this.files.createLocked(entry.path, content,
								this.author);
						fileEntry = created.entry();
						createdFolders.addAll(created.createdFolders());
						created.createdFolders()
							.forEach((folder) -> fileEvents.add(new FolderEvent(folder, this.origin)));
						fileEvents.add(FileEvent.created(fileEntry, this.origin));
					}
					else {
						TaskWrites.this.batcher.prepareWrite(this.author);
						TaskWrites.this.fs.atomicWrite(entry.path.disk(), content);
						fileEntry = TaskWrites.this.files.indexWritten(entry.path, content);
						TaskWrites.this.batcher.markDirty(entry.path, this.author);
						fileEvents.add(FileEvent.changed(fileEntry, this.origin));
					}
					written.add(fileEntry);
					TaskWrites.this.store
						.remember(TaskSnapshot.of(fileEntry.path(), Hashing.blobId(content), entry.file));
				}
				complete = true;
			}
			finally {
				// Files already written are announced even when a later write failed.
				fileEvents.forEach(TaskWrites.this.hub::publish);
				if (complete && !written.isEmpty()) {
					this.events.forEach(TaskWrites.this.hub::publish);
				}
			}
			return new Committed(List.copyOf(written), List.copyOf(createdFolders));
		}

		private Open find(TaskFile file) {
			for (Open entry : this.open.values()) {
				if (entry.file == file) {
					return entry;
				}
			}
			throw new IllegalArgumentException("The file was not read in this session");
		}

		@Override
		public void close() {
			try {
				this.held.close();
			}
			finally {
				this.operation.close();
			}
		}

	}

}
