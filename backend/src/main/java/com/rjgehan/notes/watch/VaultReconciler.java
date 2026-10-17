package com.rjgehan.notes.watch;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.Normalizer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileDeletedEvent;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.FolderDeletedEvent;
import com.rjgehan.notes.events.FolderEvent;
import com.rjgehan.notes.events.ResyncEvent;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.IndexedFile;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.index.VaultWalk;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.vault.VaultLocks;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * Brings the index in line with the disk for one path (DESIGN §5.9). Text files are compared by hash, binary and
 * over-size files by size and mtime, so the app's own writes (already indexed under the path lock) are no-ops. Every
 * external change is indexed, announced with {@code origin = null} and queued for an External commit. Existence is
 * checked by exact name in the parent directory's listing, so Windows and macOS behave like Linux.
 */
@Component
public class VaultReconciler {

	private static final Logger logger = LoggerFactory.getLogger(VaultReconciler.class);

	/** Above this many changes in one pass, a single {@code resync} replaces the individual events. */
	static final int BULK_THRESHOLD = 50;

	private final VaultLocks locks;

	private final VaultFs fs;

	private final VaultIndex index;

	private final FileIndexer indexer;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final Clock clock;

	private final ReentrantLock rescanLock = new ReentrantLock();

	private volatile @Nullable RescanInfo lastRescan;

	public VaultReconciler(VaultLocks locks, VaultFs fs, VaultIndex index, FileIndexer indexer, CommitBatcher batcher,
			EventHub hub, Clock clock) {
		this.locks = locks;
		this.fs = fs;
		this.index = index;
		this.indexer = indexer;
		this.batcher = batcher;
		this.hub = hub;
		this.clock = clock;
	}

	/** Reconciles one path under the vault read lock and the path's lock. */
	public void reconcile(ApiPath path) {
		reconcile(path, true);
	}

	/**
	 * Reconciles one path under the vault read lock and the path's lock and returns the number of changes. With
	 * {@code publish} false the changes are indexed and queued for git but not announced: a bulk rescan publishes one
	 * {@code resync} instead.
	 */
	public int reconcile(ApiPath path, boolean publish) {
		try (VaultLocks.Held held = this.locks.read(path.nfc())) {
			List<Change> changes = changesLocked(path);
			apply(changes, publish);
			return changes.size();
		}
	}

	/** For callers that already hold the vault lock and the path lock. */
	public void reconcileLocked(ApiPath path) {
		apply(changesLocked(path), true);
	}

	/**
	 * For callers that hold the vault write lock: brings a folder's subtree in line with the disk like a rescan
	 * restricted to it. Files are compared by size and mtime first and hashed only when those differ, so a large folder
	 * costs a walk rather than a read of every note.
	 */
	public void reconcileTreeLocked(ApiPath folder) {
		VaultWalk.Result walk;
		try {
			walk = VaultWalk.walk(this.fs, folder.nfc(), folder.disk());
		}
		catch (IOException ex) {
			// Gone or unreadable: reconcile the folder entry itself.
			reconcileLocked(folder);
			return;
		}
		List<Change> changes = new ArrayList<>();
		for (ApiPath path : differences(walk, folder.nfc())) {
			changes.addAll(changesLocked(path));
		}
		apply(changes, true);
	}

	/** What the last full rescan measured, for {@code /api/status}. */
	public record RescanInfo(Instant at, List<String> unwritableDirs, long repoBytes) {
	}

	public @Nullable RescanInfo lastRescan() {
		return this.lastRescan;
	}

	/**
	 * The full rescan (DESIGN §5.9): walks the vault and compares it with the index <em>without any lock</em> (text
	 * files are hashed only when their size or mtime differ), then applies each change with {@link #reconcile}, which
	 * re-checks the disk under that path's lock. Above 50 changes, or after a watcher overflow, one {@code resync}
	 * replaces the individual events. Also refreshes the skipped names, the unwritable folders and the size of
	 * {@code .git}. Returns the number of changes applied.
	 */
	public int fullRescan(boolean overflow) {
		this.rescanLock.lock();
		try {
			VaultWalk.Result walk;
			try {
				walk = VaultWalk.walk(this.fs, "", "");
			}
			catch (IOException ex) {
				logger.warn("The vault rescan failed: {}", ex.toString());
				this.hub.publish(new ResyncEvent(ResyncEvent.Reason.RESCAN_ERROR));
				return 0;
			}
			List<ApiPath> changed = differences(walk, "");
			this.index.setSkipped(walk.skipped());
			this.lastRescan = new RescanInfo(this.clock.instant(), unwritableDirs(walk), repoBytes());
			boolean bulk = overflow || changed.size() > BULK_THRESHOLD;
			int applied = 0;
			for (ApiPath path : changed) {
				try {
					applied += reconcile(path, !bulk);
				}
				catch (RuntimeException ex) {
					logger.warn("Could not reconcile {} during a rescan: {}", path.disk(), ex.toString());
				}
			}
			if (overflow) {
				this.hub.publish(new ResyncEvent(ResyncEvent.Reason.WATCHER_OVERFLOW));
			}
			else if (bulk && applied > 0) {
				this.hub.publish(new ResyncEvent(ResyncEvent.Reason.BULK_CHANGE));
			}
			if (applied > 0) {
				logger.info("Rescan applied {} external changes", applied);
			}
			return applied;
		}
		finally {
			this.rescanLock.unlock();
		}
	}

	/**
	 * The paths under {@code root} ({@code ""} for the vault) whose disk state differs from the index: new or vanished
	 * files and folders (outermost folder only, since a folder reconcile covers its subtree) and changed files.
	 * {@code walk} is the walk of {@code root}.
	 */
	private List<ApiPath> differences(VaultWalk.Result walk, String root) {
		Map<String, FileRecord> indexed = new HashMap<>();
		this.index.filesUnder(root).forEach((record) -> indexed.put(record.path(), record));
		Set<String> indexedFolders = new HashSet<>(this.index.foldersUnder(root));
		Set<String> foundFolders = new HashSet<>();
		if (!root.isEmpty()) {
			indexedFolders.add(root);
			foundFolders.add(root);
		}
		List<ApiPath> changed = new ArrayList<>();
		for (VaultWalk.FoundFolder folder : walk.folders()) {
			foundFolders.add(folder.path());
			String parent = PathNames.parentOf(folder.path());
			if (!indexedFolders.contains(folder.path()) && (parent.isEmpty() || indexedFolders.contains(parent))) {
				changed.add(new ApiPath(folder.path(), folder.disk()));
			}
		}
		for (VaultWalk.FoundFile file : walk.files()) {
			FileRecord record = indexed.remove(file.path());
			String parent = PathNames.parentOf(file.path());
			boolean parentKnown = parent.isEmpty() || indexedFolders.contains(parent);
			if ((record == null && parentKnown) || (record != null && differs(record, file))) {
				changed.add(new ApiPath(file.path(), file.disk()));
			}
		}
		for (String folder : indexedFolders) {
			String parent = PathNames.parentOf(folder);
			if (!foundFolders.contains(folder) && (parent.isEmpty() || foundFolders.contains(parent))) {
				changed.add(diskPathOf(folder));
			}
		}
		for (String gone : indexed.keySet()) {
			String parent = PathNames.parentOf(gone);
			if (parent.isEmpty() || foundFolders.contains(parent)) {
				changed.add(diskPathOf(gone));
			}
		}
		return changed;
	}

	private boolean differs(FileRecord record, VaultWalk.FoundFile file) {
		if (!this.indexer.matches(record, file.size())) {
			return true;
		}
		if (record.size() == file.size() && record.mtime().equals(file.mtime())) {
			return false;
		}
		if (!this.indexer.isIndexedText(file.path(), file.size()) || record.version() == null) {
			return true;
		}
		try {
			return !record.version().equals(Hashing.blobId(this.fs.resolve(file.disk())));
		}
		catch (IOException ex) {
			return true;
		}
	}

	private ApiPath diskPathOf(String path) {
		String disk = this.index.diskPath(path);
		return new ApiPath(path, (disk != null) ? disk : path);
	}

	/** Folders (and the vault root, as {@code ""}) that the server process cannot write to. */
	private List<String> unwritableDirs(VaultWalk.Result walk) {
		List<String> unwritable = new ArrayList<>();
		if (!Files.isWritable(this.fs.root())) {
			unwritable.add("");
		}
		for (VaultWalk.FoundFolder folder : walk.folders()) {
			if (!Files.isWritable(this.fs.resolve(folder.disk()))) {
				unwritable.add(folder.path());
			}
		}
		if (!unwritable.isEmpty()) {
			logger.warn("The server cannot write to these folders: {}", unwritable);
		}
		return List.copyOf(unwritable);
	}

	/** The size of {@code .git} in bytes (0 when there is none), without following links. */
	private long repoBytes() {
		Path gitDir = this.fs.resolve(".git");
		if (VaultFs.attributes(gitDir) == null) {
			return 0;
		}
		long[] total = { 0 };
		try {
			Files.walkFileTree(gitDir, new SimpleFileVisitor<>() {

				@Override
				public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
					total[0] += attributes.size();
					return FileVisitResult.CONTINUE;
				}

				@Override
				public FileVisitResult visitFileFailed(Path file, IOException exc) {
					return FileVisitResult.CONTINUE;
				}

			});
		}
		catch (IOException ex) {
			logger.debug("Cannot measure .git: {}", ex.toString());
		}
		return total[0];
	}

	private List<Change> changesLocked(ApiPath path) {
		String parent = path.parent();
		if (!this.index.isFolder(parent)) {
			// The parent appeared externally too: reconcile the outermost folder the index does not know.
			String top = parent;
			while (!this.index.isFolder(PathNames.parentOf(top))) {
				top = PathNames.parentOf(top);
			}
			int depth = PathNames.segmentCount(top);
			String topDisk = String.join("/", List.of(path.disk().split("/")).subList(0, depth));
			return reconcileEntry(top, topDisk);
		}
		return reconcileEntry(path.nfc(), path.disk());
	}

	private List<Change> reconcileEntry(String path, String disk) {
		List<Change> changes = new ArrayList<>();
		String actualName = exactChild(PathNames.parentOf(disk), PathNames.nameOf(path), PathNames.nameOf(disk));
		FileRecord record = this.index.file(path);
		boolean folder = this.index.isFolder(path);
		BasicFileAttributes attributes = null;
		String actualDisk = null;
		if (actualName != null) {
			actualDisk = PathNames.join(PathNames.parentOf(disk), actualName);
			attributes = this.fs.attributes(actualDisk);
			if (attributes != null && (attributes.isSymbolicLink() || attributes.isOther())) {
				attributes = null;
			}
		}
		if (attributes == null) {
			if (record != null) {
				removeFile(path, changes);
			}
			else if (folder) {
				removeFolder(path, changes);
			}
			return changes;
		}
		if (attributes.isDirectory()) {
			if (record != null) {
				removeFile(path, changes);
			}
			reconcileSubtree(path, actualDisk, changes);
			return changes;
		}
		if (folder) {
			removeFolder(path, changes);
		}
		if (NameRules.isIgnored(actualName)) {
			return changes;
		}
		indexFile(path, actualDisk, attributes, record, changes);
		return changes;
	}

	private void reconcileSubtree(String folder, String folderDisk, List<Change> changes) {
		VaultWalk.Result walk;
		try {
			walk = VaultWalk.walk(this.fs, folder, folderDisk);
		}
		catch (IOException ex) {
			logger.warn("Cannot reconcile folder {}: {}", folderDisk, ex.toString());
			return;
		}
		for (String added : this.index.addFolder(folder, folderDisk)) {
			changes.add(Change.of(new FolderEvent(added, null)));
		}
		Set<String> foundFolders = new HashSet<>();
		for (VaultWalk.FoundFolder found : walk.folders()) {
			foundFolders.add(found.path());
			for (String added : this.index.addFolder(found.path(), found.disk())) {
				changes.add(Change.of(new FolderEvent(added, null)));
			}
		}
		Map<String, FileRecord> indexed = new HashMap<>();
		for (FileRecord record : this.index.filesUnder(folder)) {
			indexed.put(record.path(), record);
		}
		for (VaultWalk.FoundFile found : walk.files()) {
			BasicFileAttributes attributes = this.fs.attributes(found.disk());
			FileRecord record = indexed.remove(found.path());
			if (attributes != null && attributes.isRegularFile()) {
				indexFile(found.path(), found.disk(), attributes, record, changes);
			}
		}
		// Vanished folders first (outermost only), so their files are covered by one folder.deleted.
		for (String known : this.index.foldersUnder(folder)) {
			if (!foundFolders.contains(known) && this.index.isFolder(known)) {
				removeFolder(known, changes);
			}
		}
		for (String gone : indexed.keySet()) {
			if (this.index.file(gone) != null) {
				removeFile(gone, changes);
			}
		}
	}

	private void indexFile(String path, String disk, BasicFileAttributes attributes, @Nullable FileRecord record,
			List<Change> changes) {
		try {
			if (record != null && unchanged(record, disk, attributes)) {
				return;
			}
			IndexedFile file = this.indexer.load(path, disk);
			boolean created = this.index.file(path) == null;
			for (String added : this.index.addFolder(PathNames.parentOf(path), PathNames.parentOf(disk))) {
				changes.add(Change.of(new FolderEvent(added, null)));
			}
			var entry = this.index.put(file);
			changes.add(new Change(created ? FileEvent.created(entry, null) : FileEvent.changed(entry, null),
					List.of(new ApiPath(path, disk))));
		}
		catch (IOException ex) {
			logger.debug("{} vanished while it was being reconciled", disk);
			if (this.index.file(path) != null) {
				removeFile(path, changes);
			}
		}
	}

	private boolean unchanged(FileRecord record, String disk, BasicFileAttributes attributes) throws IOException {
		if (!this.indexer.matches(record, attributes.size())) {
			return false;
		}
		boolean text = this.indexer.isIndexedText(record.path(), attributes.size());
		if (text) {
			return record.version().equals(Hashing.blobId(this.fs.resolve(disk)));
		}
		return record.size() == attributes.size()
				&& record.mtime().equals(attributes.lastModifiedTime().toInstant());
	}

	private void removeFile(String path, List<Change> changes) {
		String disk = this.index.diskPath(path);
		this.index.removeFile(path);
		changes.add(new Change(new FileDeletedEvent(path, false, null, null),
				List.of(new ApiPath(path, (disk != null) ? disk : path))));
	}

	private void removeFolder(String folder, List<Change> changes) {
		List<ApiPath> files = new ArrayList<>();
		for (FileRecord record : this.index.filesUnder(folder)) {
			String disk = this.index.diskPath(record.path());
			files.add(new ApiPath(record.path(), (disk != null) ? disk : record.path()));
		}
		this.index.removeFolder(folder);
		changes.add(new Change(new FolderDeletedEvent(folder, false, null, null), files));
	}

	/**
	 * Publishes the events (or one {@code resync} for a bulk change) unless {@code publish} is false, and queues
	 * External commits.
	 */
	private void apply(List<Change> changes, boolean publish) {
		if (changes.isEmpty()) {
			return;
		}
		if (publish && changes.size() > BULK_THRESHOLD) {
			this.hub.publish(new ResyncEvent(ResyncEvent.Reason.BULK_CHANGE));
		}
		else if (publish) {
			changes.forEach((change) -> this.hub.publish(change.event()));
		}
		for (Change change : changes) {
			change.dirty().forEach((path) -> this.batcher.markDirty(path, Author.EXTERNAL));
		}
	}

	/**
	 * The actual on-disk name in {@code parentDisk} for a child: the exact disk name if listed, else a name whose NFC
	 * form equals {@code nfcName}; null when neither is listed. Case differences do not match.
	 */
	private @Nullable String exactChild(String parentDisk, String nfcName, String diskName) {
		Path dir = this.fs.resolve(parentDisk);
		String normalized = null;
		try (DirectoryStream<Path> children = Files.newDirectoryStream(dir)) {
			for (Path child : children) {
				String name = child.getFileName().toString();
				if (name.equals(diskName)) {
					return name;
				}
				if (normalized == null && Normalizer.normalize(name, Normalizer.Form.NFC).equals(nfcName)) {
					normalized = name;
				}
			}
		}
		catch (IOException ex) {
			return null;
		}
		return normalized;
	}

	/** An event to publish and the paths it makes dirty. */
	private record Change(VaultEvent event, List<ApiPath> dirty) {

		static Change of(VaultEvent event) {
			return new Change(event, List.of());
		}

	}

}
