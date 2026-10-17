package com.rjgehan.notes.history;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import java.util.stream.Stream;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.VaultFs;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.EmptyCommitException;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.diff.DiffConfig;
import org.eclipse.jgit.diff.DiffEntry;
import org.eclipse.jgit.errors.ConfigInvalidException;
import org.eclipse.jgit.errors.IncorrectObjectTypeException;
import org.eclipse.jgit.errors.MissingObjectException;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.FileMode;
import org.eclipse.jgit.lib.NullProgressMonitor;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectLoader;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.lib.RepositoryState;
import org.eclipse.jgit.lib.StoredConfig;
import org.eclipse.jgit.revwalk.FollowFilter;
import org.eclipse.jgit.revwalk.RenameCallback;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.storage.file.FileBasedConfig;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.eclipse.jgit.treewalk.EmptyTreeIterator;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.treewalk.filter.PathFilterGroup;
import org.eclipse.jgit.util.FS;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;

/**
 * Owns the vault's single JGit repository (DESIGN §5.8): open or init, stale-lock cleanup, repository config and
 * {@code info/exclude}, staging and committing, reading old versions, {@code log --follow}, and gc. Every mutating
 * call runs under {@code gitLock}; reads use their own walkers and readers. Paths given to git are always the
 * repo-relative on-disk paths, mapped back to NFC on output.
 */
@Component
public class GitStore implements DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(GitStore.class);

	static final String HOOKS_DIR = "notesapp-no-hooks";

	static final String EXCLUDE = """
			# managed by NotesApp: rewritten at startup
			.notesapp/cache/
			.notesapp/tmp/
			.notesapp/trash.json
			.trash/
			.obsidian/workspace*.json
			.notesapp-*.tmp
			.DS_Store
			Thumbs.db
			*.swp
			*~
			""";

	private static final int MAX_SUBJECT = 120;

	/** A staged change of one path. {@code path} is the NFC path. */
	public record Change(ChangeType type, String path) {
	}

	public record Message(String subject, @Nullable String body) {
	}

	/** A commit that was made. {@code paths} are the NFC paths it changed. */
	public record Commit(String id, String subject, Author author, Instant time, List<String> paths) {
	}

	/** A file's bytes at a commit. */
	public record Blob(String id, byte[] bytes) {
	}

	/** A file's blob id and size at a commit. */
	public record BlobInfo(String id, long size) {
	}

	/** One entry of a per-file history walk. */
	public record LogEntry(RevCommit commit, @Nullable String parentId, String path, ChangeType change,
			@Nullable String renamedFrom) {
	}

	public record LogPage(List<LogEntry> entries, boolean hasMore) {
	}

	private final Path root;

	private final NotesProperties.Git properties;

	private final Clock clock;

	private final ReentrantLock gitLock = new ReentrantLock();

	private volatile @Nullable Git git;

	private volatile @Nullable String unusableReason;

	private volatile boolean createdThisBoot;

	public GitStore(VaultFs fs, NotesProperties properties, Clock clock) {
		this.root = fs.root();
		this.properties = properties.git();
		this.clock = clock;
	}

	// ---------------------------------------------------------------- lifecycle

	/** Opens or initializes the repository and checks that the app can use it. */
	public void openOrInit() throws IOException {
		if (!this.properties.enabled()) {
			logger.info("Git history is disabled by configuration");
			return;
		}
		Path gitDir = this.root.resolve(Constants.DOT_GIT);
		if (Files.isDirectory(gitDir)) {
			removeStaleLocks(gitDir);
		}
		Repository repository;
		if (Files.isDirectory(gitDir)) {
			repository = new FileRepositoryBuilder().setGitDir(gitDir.toFile()).setWorkTree(this.root.toFile()).build();
		}
		else {
			try {
				repository = Git.init()
					.setDirectory(this.root.toFile())
					.setInitialBranch("main")
					.call()
					.getRepository();
			}
			catch (GitAPIException ex) {
				throw new IOException("Cannot initialize the git repository", ex);
			}
			this.createdThisBoot = true;
			logger.info("Initialized a git repository in {}", gitDir);
		}
		configure(repository, gitDir);
		this.git = new Git(repository);
		logRepository(repository);
		this.unusableReason = unusableReason(repository);
		if (this.unusableReason != null) {
			logger.warn("Git history is disabled: {}", this.unusableReason);
		}
	}

	/**
	 * Closes the repository. {@code Git.shutdown()} is deliberately not called: it terminates JGit's process-wide work
	 * queue for good, so any later application context in the same JVM (an integration test restarting the app) would
	 * fail inside JGit. Its threads are daemons, and JGit cleans up in its own JVM shutdown hook.
	 */
	@Override
	public void destroy() {
		close();
	}

	/** Closes the repository. */
	public void close() {
		Git current = this.git;
		this.git = null;
		if (current != null) {
			this.gitLock.lock();
			try {
				current.close();
			}
			finally {
				this.gitLock.unlock();
			}
		}
	}

	/** True when history works: enabled by configuration and the repository is usable. */
	public boolean isEnabled() {
		return this.git != null && this.unusableReason == null;
	}

	/** Why history is off, for example {@code "disabled by configuration"} or {@code "HEAD is detached"}; else null. */
	public @Nullable String disabledReason() {
		if (!this.properties.enabled()) {
			return "disabled by configuration";
		}
		return (this.git == null) ? "not initialized" : this.unusableReason;
	}

	/** True when history is off because of configuration rather than an unusable repository. */
	public boolean isDisabledByConfiguration() {
		return !this.properties.enabled();
	}

	public boolean createdThisBoot() {
		return this.createdThisBoot;
	}

	public boolean hasCommits() throws IOException {
		return head() != null;
	}

	public @Nullable String head() throws IOException {
		Git current = this.git;
		if (current == null) {
			return null;
		}
		ObjectId head = current.getRepository().resolve(Constants.HEAD);
		return (head != null) ? head.name() : null;
	}

	/** The repository the app manages, for tests and diagnostics. */
	Repository repository() {
		Git current = this.git;
		if (current == null) {
			throw new IllegalStateException("The repository is not open");
		}
		return current.getRepository();
	}

	// ---------------------------------------------------------------- commits

	/**
	 * Stages {@code present} paths with {@code git add} and the others with {@code git rm --cached}, then commits
	 * whatever changed. Returns null when nothing changed. {@code message} receives the actual changes.
	 */
	public @Nullable Commit commit(Collection<ApiPath> present, Collection<ApiPath> removed,
			Function<List<Change>, Message> message, Author author) throws IOException, GitAPIException {
		Git current = requireGit();
		this.gitLock.lock();
		try {
			if (!present.isEmpty()) {
				var add = current.add().setRenormalize(false);
				present.forEach((path) -> add.addFilepattern(path.disk()));
				add.call();
			}
			if (!removed.isEmpty()) {
				var rm = current.rm().setCached(true);
				removed.forEach((path) -> rm.addFilepattern(path.disk()));
				rm.call();
			}
			Map<String, String> nfcByDisk = new HashMap<>();
			Stream.concat(present.stream(), removed.stream()).forEach((p) -> nfcByDisk.put(p.disk(), p.nfc()));
			List<Change> changes = stagedChanges(current, nfcByDisk);
			if (changes.isEmpty()) {
				return null;
			}
			return doCommit(current, message.apply(changes), author, changes);
		}
		finally {
			this.gitLock.unlock();
		}
	}

	/** Stages the whole working tree (additions, modifications and deletions) and commits it; null when clean. */
	public @Nullable Commit commitAll(Function<List<Change>, Message> message, Author author)
			throws IOException, GitAPIException {
		Git current = requireGit();
		this.gitLock.lock();
		try {
			current.add().addFilepattern(".").setRenormalize(false).call();
			current.add().addFilepattern(".").setUpdate(true).setRenormalize(false).call();
			List<Change> changes = stagedChanges(current, Map.of());
			if (changes.isEmpty()) {
				return null;
			}
			return doCommit(current, message.apply(changes), author, changes);
		}
		finally {
			this.gitLock.unlock();
		}
	}

	/** True when the working tree differs from {@code HEAD} (including untracked files). */
	public boolean isDirty() throws GitAPIException {
		Git current = requireGit();
		this.gitLock.lock();
		try {
			return !current.status().call().isClean();
		}
		finally {
			this.gitLock.unlock();
		}
	}

	/** Runs {@code autoGC} inline (with {@code gc.autoDetach=false}); it does nothing when gc is not needed. */
	public void gc() throws IOException {
		Git current = this.git;
		if (current == null || !isEnabled()) {
			return;
		}
		this.gitLock.lock();
		try {
			current.getRepository().autoGC(NullProgressMonitor.INSTANCE);
		}
		finally {
			this.gitLock.unlock();
		}
	}

	private Commit doCommit(Git current, Message message, Author author, List<Change> changes)
			throws GitAPIException {
		Instant now = this.clock.instant();
		String subject = truncate(message.subject());
		String full = (message.body() != null && !message.body().isBlank()) ? subject + "\n\n" + message.body()
				: subject;
		try {
			RevCommit commit = current.commit()
				.setMessage(full)
				.setAuthor(author.ident(now))
				.setCommitter(new Author(this.properties.committerName(), this.properties.committerEmail()).ident(now))
				.setAllowEmpty(false)
				.setNoVerify(true)
				.setSign(false)
				.call();
			logger.info("Committed {} {}", commit.abbreviate(7).name(), subject);
			return new Commit(commit.name(), subject, author, now, changes.stream().map(Change::path).toList());
		}
		catch (EmptyCommitException ex) {
			throw new IllegalStateException("Staged changes disappeared before the commit", ex);
		}
	}

	private static List<Change> stagedChanges(Git current, Map<String, String> nfcByDisk)
			throws IOException, GitAPIException {
		var diff = current.diff().setCached(true).setShowNameAndStatusOnly(true);
		if (!nfcByDisk.isEmpty()) {
			diff.setPathFilter(PathFilterGroup.createFromStrings(nfcByDisk.keySet()));
		}
		if (current.getRepository().resolve(Constants.HEAD + "^{tree}") == null) {
			diff.setOldTree(new EmptyTreeIterator());
		}
		List<Change> changes = new ArrayList<>();
		for (DiffEntry entry : diff.call()) {
			ChangeType type = switch (entry.getChangeType()) {
				case ADD, COPY -> ChangeType.ADDED;
				case DELETE -> ChangeType.DELETED;
				case RENAME -> ChangeType.RENAMED;
				case MODIFY -> ChangeType.MODIFIED;
			};
			String disk = (entry.getChangeType() == DiffEntry.ChangeType.DELETE) ? entry.getOldPath()
					: entry.getNewPath();
			changes.add(new Change(type, nfc(nfcByDisk, disk)));
		}
		return changes;
	}

	private static String nfc(Map<String, String> nfcByDisk, String disk) {
		String known = nfcByDisk.get(disk);
		if (known != null) {
			return known;
		}
		for (Map.Entry<String, String> entry : nfcByDisk.entrySet()) {
			if (disk.startsWith(entry.getKey() + "/")) {
				return entry.getValue() + Normalizer.normalize(disk.substring(entry.getKey().length()),
						Normalizer.Form.NFC);
			}
		}
		return Normalizer.normalize(disk, Normalizer.Form.NFC);
	}

	// ---------------------------------------------------------------- reads

	/**
	 * The bytes of {@code path} at {@code commitId} (a full 40-hex id), or null when the commit is unknown or the path
	 * is absent there. The lookup compares NFC-normalized names, preferring an exact match, so files whose names are
	 * NFD on disk are found by their NFC path.
	 */
	public @Nullable Blob readAt(String commitId, String path) throws IOException {
		BlobInfo info = blobAt(commitId, path);
		if (info == null) {
			return null;
		}
		try (InputStream in = open(info.id())) {
			return new Blob(info.id(), in.readAllBytes());
		}
	}

	/** The id and size of {@code path} at {@code commitId} without loading it, or null when absent. */
	public @Nullable BlobInfo blobAt(String commitId, String path) throws IOException {
		Repository repository = requireGit().getRepository();
		try (RevWalk walk = new RevWalk(repository); ObjectReader reader = repository.newObjectReader()) {
			RevCommit commit;
			try {
				commit = walk.parseCommit(ObjectId.fromString(commitId));
			}
			catch (MissingObjectException | IncorrectObjectTypeException ex) {
				return null;
			}
			ObjectId blob = lookup(reader, commit.getTree(), path);
			return (blob != null) ? new BlobInfo(blob.name(), reader.getObjectSize(blob, Constants.OBJ_BLOB)) : null;
		}
	}

	/** Streams a blob; large blobs are never loaded into memory at once. */
	public InputStream open(String blobId) throws IOException {
		Repository repository = requireGit().getRepository();
		ObjectLoader loader = repository.open(ObjectId.fromString(blobId), Constants.OBJ_BLOB);
		return loader.openStream();
	}

	/** The on-disk form of an NFC path as it appears in {@code HEAD}, or null when absent there. */
	public @Nullable String diskPathAtHead(String path) throws IOException {
		Git current = requireGit();
		Repository repository = current.getRepository();
		ObjectId head = repository.resolve(Constants.HEAD + "^{tree}");
		if (head == null) {
			return null;
		}
		try (ObjectReader reader = repository.newObjectReader()) {
			return lookupDiskPath(reader, head, path);
		}
	}

	/**
	 * The history of one path, following renames ({@code git log --follow}), newest first. {@code diskPath} is the
	 * path's on-disk form at {@code HEAD} (or its last known form).
	 */
	public LogPage log(String diskPath, int offset, int limit) throws IOException {
		Git current = requireGit();
		Repository repository = current.getRepository();
		ObjectId head = repository.resolve(Constants.HEAD);
		if (head == null) {
			return new LogPage(List.of(), false);
		}
		Map<RevCommit, DiffEntry> renames = new HashMap<>();
		try (RevWalk walk = new RevWalk(repository)) {
			FollowFilter follow = FollowFilter.create(diskPath, repository.getConfig().get(DiffConfig.KEY));
			follow.setRenameCallback(new RenameCallback() {

				@Override
				public void renamed(DiffEntry entry) {
					// The commit-aware overload below is the one JGit calls during a walk.
				}

				@Override
				public void renamed(DiffEntry entry, RevCommit commit) {
					renames.put(commit, entry);
				}

			});
			walk.setTreeFilter(follow);
			walk.setRewriteParents(false);
			walk.markStart(walk.parseCommit(head));
			String currentPath = diskPath;
			List<LogEntry> entries = new ArrayList<>();
			int index = 0;
			boolean hasMore = false;
			for (RevCommit commit = walk.next(); commit != null; commit = walk.next()) {
				DiffEntry rename = renames.get(commit);
				String pathAtCommit;
				String renamedFrom = null;
				ChangeType change;
				RevCommit parent = (commit.getParentCount() > 0) ? walk.parseCommit(commit.getParent(0)) : null;
				if (rename != null) {
					pathAtCommit = rename.getNewPath();
					renamedFrom = rename.getOldPath();
					change = ChangeType.RENAMED;
					currentPath = rename.getOldPath();
				}
				else {
					pathAtCommit = currentPath;
					boolean presentHere = TreeWalk.forPath(repository, pathAtCommit, commit.getTree()) != null;
					boolean presentBefore = parent != null
							&& TreeWalk.forPath(repository, pathAtCommit, parent.getTree()) != null;
					change = !presentHere ? ChangeType.DELETED
							: !presentBefore ? ChangeType.ADDED : ChangeType.MODIFIED;
				}
				if (index++ < offset) {
					continue;
				}
				if (entries.size() == limit) {
					hasMore = true;
					break;
				}
				entries.add(new LogEntry(commit, (parent != null) ? parent.name() : null, toNfc(pathAtCommit), change,
						(renamedFrom != null) ? toNfc(renamedFrom) : null));
			}
			return new LogPage(entries, hasMore);
		}
	}

	private static String toNfc(String disk) {
		return Normalizer.normalize(disk, Normalizer.Form.NFC);
	}

	private static @Nullable ObjectId lookup(ObjectReader reader, ObjectId tree, String path) throws IOException {
		String[] segments = path.split("/");
		ObjectId current = tree;
		for (int i = 0; i < segments.length; i++) {
			Match match = child(reader, current, segments[i]);
			if (match == null) {
				return null;
			}
			boolean last = i == segments.length - 1;
			if (last) {
				return FileMode.REGULAR_FILE.equals(match.mode()) || FileMode.EXECUTABLE_FILE.equals(match.mode())
						? match.id() : null;
			}
			if (!FileMode.TREE.equals(match.mode())) {
				return null;
			}
			current = match.id();
		}
		return null;
	}

	private static @Nullable String lookupDiskPath(ObjectReader reader, ObjectId tree, String path)
			throws IOException {
		String[] segments = path.split("/");
		ObjectId current = tree;
		StringBuilder disk = new StringBuilder();
		for (int i = 0; i < segments.length; i++) {
			Match match = child(reader, current, segments[i]);
			if (match == null) {
				return null;
			}
			if (i > 0) {
				disk.append('/');
			}
			disk.append(match.name());
			current = match.id();
		}
		return disk.toString();
	}

	private record Match(String name, ObjectId id, FileMode mode) {
	}

	private static @Nullable Match child(ObjectReader reader, ObjectId tree, String nfcName) throws IOException {
		Match normalized = null;
		try (TreeWalk walk = new TreeWalk(reader)) {
			walk.addTree(tree);
			walk.setRecursive(false);
			while (walk.next()) {
				String name = walk.getNameString();
				if (name.equals(nfcName)) {
					return new Match(name, walk.getObjectId(0), walk.getFileMode(0));
				}
				if (normalized == null && Normalizer.normalize(name, Normalizer.Form.NFC).equals(nfcName)) {
					normalized = new Match(name, walk.getObjectId(0), walk.getFileMode(0));
				}
			}
		}
		return normalized;
	}

	// ---------------------------------------------------------------- setup

	private Git requireGit() {
		Git current = this.git;
		if (current == null) {
			throw new IllegalStateException("Git history is not available");
		}
		return current;
	}

	/** Deletes lock files left by a killed process; the app is the only git writer. */
	static void removeStaleLocks(Path gitDir) throws IOException {
		for (String name : List.of("index.lock", "HEAD.lock", "config.lock", "packed-refs.lock")) {
			deleteLock(gitDir.resolve(name));
		}
		Path refs = gitDir.resolve("refs");
		if (Files.isDirectory(refs)) {
			try (Stream<Path> files = Files.walk(refs)) {
				for (Path lock : files.filter((p) -> p.getFileName().toString().endsWith(".lock")).toList()) {
					deleteLock(lock);
				}
			}
		}
	}

	private static void deleteLock(Path lock) throws IOException {
		if (Files.deleteIfExists(lock)) {
			logger.warn("Removed stale git lock {}", lock);
		}
	}

	private static void configure(Repository repository, Path gitDir) throws IOException {
		StoredConfig config = repository.getConfig();
		config.setBoolean("core", null, "autocrlf", false);
		config.setBoolean("commit", null, "gpgsign", false);
		config.setBoolean("gc", null, "autoDetach", false);
		config.setBoolean("diff", null, "renames", true);
		config.setInt("diff", null, "renameLimit", 10000);
		config.setString("core", null, "hooksPath", Constants.DOT_GIT + "/" + HOOKS_DIR);
		config.save();
		Files.createDirectories(gitDir.resolve(HOOKS_DIR));
		Path info = gitDir.resolve("info");
		Files.createDirectories(info);
		Files.writeString(info.resolve("exclude"), EXCLUDE, StandardCharsets.UTF_8);
	}

	private static void logRepository(Repository repository) throws IOException {
		Set<String> remotes = repository.getConfig().getSubsections("remote");
		logger.info("Git branch: {}; remotes: {}", repository.getBranch(), remotes.isEmpty() ? "none" : remotes);
		for (String remote : remotes) {
			logger.info("Remote {}: {}", remote, repository.getConfig().getString("remote", remote, "url"));
		}
	}

	private static @Nullable String unusableReason(Repository repository) throws IOException {
		Ref head = repository.exactRef(Constants.HEAD);
		if (head != null && !head.isSymbolic()) {
			return "HEAD is detached";
		}
		RepositoryState state = repository.getRepositoryState();
		if (state != RepositoryState.SAFE) {
			return "the repository is in state '" + state.getDescription() + "' (a merge or rebase is in progress)";
		}
		if (usesLfs(repository)) {
			return "git-lfs is not supported";
		}
		return null;
	}

	/**
	 * LFS is detected from the repository itself: its own config, its {@code lfs} store, or a {@code filter=lfs}
	 * attribute. A user-level {@code filter.lfs} (which {@code git lfs install} writes for every repository on a
	 * developer machine) does not make this repository an LFS one.
	 */
	static boolean usesLfs(Repository repository) throws IOException {
		Path gitDir = repository.getDirectory().toPath();
		FileBasedConfig local = new FileBasedConfig(gitDir.resolve("config").toFile(), FS.DETECTED);
		try {
			local.load();
		}
		catch (ConfigInvalidException ex) {
			throw new IOException("The repository config is invalid", ex);
		}
		if (local.getSubsections("filter").contains("lfs") || Files.isDirectory(gitDir.resolve("lfs"))) {
			return true;
		}
		Path attributes = repository.getWorkTree().toPath().resolve(Constants.DOT_GIT_ATTRIBUTES);
		return Files.isRegularFile(attributes)
				&& Files.readString(attributes, StandardCharsets.UTF_8).contains("filter=lfs");
	}

	static String truncate(String subject) {
		return (subject.length() <= MAX_SUBJECT) ? subject : subject.substring(0, MAX_SUBJECT - 1) + "…";
	}

}
