package com.rjgehan.notes.history;

import java.io.IOException;
import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.api.dto.ChangeType;
import org.eclipse.jgit.diff.DiffEntry;
import org.eclipse.jgit.diff.RenameDetector;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.NullProgressMonitor;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.ObjectReader;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.revwalk.RevCommit;
import org.eclipse.jgit.revwalk.RevSort;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.AbstractTreeIterator;
import org.eclipse.jgit.treewalk.CanonicalTreeParser;
import org.eclipse.jgit.treewalk.EmptyTreeIterator;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.treewalk.filter.AndTreeFilter;
import org.eclipse.jgit.treewalk.filter.PathFilter;
import org.eclipse.jgit.treewalk.filter.TreeFilter;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The vault-wide history (ROADMAP item 28, DESIGN §5.8): every commit with the files it changed, filtered by path,
 * author and time; the net change between two points in time ("what changed this week"); and every file that was
 * deleted and does not exist any more, so it can be restored from git even after the trash was emptied. Read-only:
 * every call uses its own walker and reader. Paths in the results are NFC; hidden paths ({@code .notesapp/…}) are
 * left out. Renames are detected as in per-file history ({@code diff.renames}).
 */
@Component
public class GitTimeline {

	/** At most this many files are listed per commit. */
	public static final int MAX_FILES_PER_COMMIT = 100;

	/** At most this many files are listed for a period. */
	public static final int MAX_CHANGED_FILES = 1000;

	/** One changed file. {@code renamedFrom} is set for a rename. */
	public record FileChange(String path, ChangeType change, @Nullable String renamedFrom) {
	}

	/** A commit and the visible files it changed (at most {@value #MAX_FILES_PER_COMMIT} of {@code filesTotal}). */
	public record CommitChanges(RevCommit commit, @Nullable String parentId, List<FileChange> files, int filesTotal) {
	}

	public record LogPage(List<CommitChanges> commits, boolean hasMore) {
	}

	/** Filters for {@link #log}; null means "any". {@code until} is exclusive. */
	public record Filter(@Nullable String diskPath, @Nullable String author, @Nullable Instant since,
			@Nullable Instant until) {
	}

	/** The net change between the last commit before {@code since} and the last commit before {@code until}. */
	public record Changes(@Nullable String fromCommitId, @Nullable String toCommitId, int commits,
			List<String> authors, List<FileChange> files, boolean truncated) {
	}

	/** The latest deletion of a path. {@code parentId} holds its last content. */
	public record Deletion(String path, RevCommit commit, String parentId) {
	}

	private final GitStore git;

	private final Object deletionsLock = new Object();

	private @Nullable ObjectId deletionsHead;

	private final Map<String, Deletion> deletions = new HashMap<>();

	public GitTimeline(GitStore git) {
		this.git = git;
	}

	// ---------------------------------------------------------------- log

	/** Commits newest first (by commit time), with their files; {@code offset} and {@code limit} page them. */
	public LogPage log(Filter filter, int offset, int limit) throws IOException {
		Repository repository = this.git.repository();
		ObjectId head = repository.resolve(Constants.HEAD);
		if (head == null) {
			return new LogPage(List.of(), false);
		}
		String author = (filter.author() != null) ? filter.author().toLowerCase(Locale.ROOT) : null;
		TreeFilter paths = (filter.diskPath() != null) ? PathFilter.create(filter.diskPath()) : null;
		try (RevWalk walk = new RevWalk(repository); ObjectReader reader = repository.newObjectReader()) {
			walk.sort(RevSort.COMMIT_TIME_DESC);
			if (paths != null) {
				walk.setTreeFilter(AndTreeFilter.create(paths, TreeFilter.ANY_DIFF));
				walk.setRewriteParents(false);
			}
			walk.markStart(walk.parseCommit(head));
			List<CommitChanges> commits = new ArrayList<>();
			int skipped = 0;
			for (RevCommit commit = walk.next(); commit != null; commit = walk.next()) {
				Instant time = Instant.ofEpochSecond(commit.getCommitTime());
				if (filter.until() != null && !time.isBefore(filter.until())) {
					continue;
				}
				if (filter.since() != null && time.isBefore(filter.since())) {
					break;
				}
				if (author != null && !matchesAuthor(commit.getAuthorIdent(), author)) {
					continue;
				}
				if (skipped++ < offset) {
					continue;
				}
				if (commits.size() == limit) {
					return new LogPage(commits, true);
				}
				commits.add(changes(repository, reader, walk, commit, paths));
			}
			return new LogPage(commits, false);
		}
	}

	private static boolean matchesAuthor(PersonIdent ident, String needle) {
		return ident.getName().toLowerCase(Locale.ROOT).contains(needle)
				|| ident.getEmailAddress().toLowerCase(Locale.ROOT).contains(needle);
	}

	private CommitChanges changes(Repository repository, ObjectReader reader, RevWalk walk, RevCommit commit,
			@Nullable TreeFilter paths) throws IOException {
		RevCommit parent = (commit.getParentCount() > 0) ? walk.parseCommit(commit.getParent(0)) : null;
		List<FileChange> all = diff(repository, reader, (parent != null) ? parent.getTree() : null, commit.getTree(),
				paths);
		List<FileChange> files = all.subList(0, Math.min(all.size(), MAX_FILES_PER_COMMIT));
		return new CommitChanges(commit, (parent != null) ? parent.name() : null, List.copyOf(files), all.size());
	}

	// ---------------------------------------------------------------- changes over a period

	/** What changed between {@code since} and {@code until} (both may be null: the beginning, and now). */
	public Changes changes(@Nullable Instant since, @Nullable Instant until, @Nullable String diskPath)
			throws IOException {
		Repository repository = this.git.repository();
		ObjectId head = repository.resolve(Constants.HEAD);
		if (head == null) {
			return new Changes(null, null, 0, List.of(), List.of(), false);
		}
		try (RevWalk walk = new RevWalk(repository); ObjectReader reader = repository.newObjectReader()) {
			walk.sort(RevSort.COMMIT_TIME_DESC);
			walk.markStart(walk.parseCommit(head));
			RevCommit to = null;
			RevCommit from = null;
			int commits = 0;
			Set<String> authors = new LinkedHashSet<>();
			for (RevCommit commit = walk.next(); commit != null; commit = walk.next()) {
				Instant time = Instant.ofEpochSecond(commit.getCommitTime());
				if (until != null && !time.isBefore(until)) {
					continue;
				}
				if (since != null && time.isBefore(since)) {
					from = commit;
					break;
				}
				if (to == null) {
					to = commit;
				}
				commits++;
				authors.add(commit.getAuthorIdent().getName());
			}
			if (to == null) {
				return new Changes((from != null) ? from.name() : null, (from != null) ? from.name() : null, 0,
						List.of(), List.of(), false);
			}
			TreeFilter paths = (diskPath != null) ? PathFilter.create(diskPath) : null;
			List<FileChange> files = diff(repository, reader, (from != null) ? from.getTree() : null, to.getTree(),
					paths);
			boolean truncated = files.size() > MAX_CHANGED_FILES;
			return new Changes((from != null) ? from.name() : null, to.name(), commits, List.copyOf(authors),
					List.copyOf(files.subList(0, Math.min(files.size(), MAX_CHANGED_FILES))), truncated);
		}
	}

	// ---------------------------------------------------------------- deleted files

	/**
	 * The newest deletion of every path whose latest change in history is a deletion, newest first. Computed from
	 * the whole history once, then only from the commits made since.
	 */
	public List<Deletion> deletions() throws IOException {
		Repository repository = this.git.repository();
		synchronized (this.deletionsLock) {
			ObjectId head = repository.resolve(Constants.HEAD);
			if (head == null) {
				this.deletions.clear();
				this.deletionsHead = null;
				return List.of();
			}
			if (!head.equals(this.deletionsHead)) {
				update(repository, head);
				this.deletionsHead = head.copy();
			}
			List<Deletion> result = new ArrayList<>(this.deletions.values());
			result.sort((a, b) -> Integer.compare(b.commit().getCommitTime(), a.commit().getCommitTime()));
			return result;
		}
	}

	private void update(Repository repository, ObjectId head) throws IOException {
		try (RevWalk walk = new RevWalk(repository); ObjectReader reader = repository.newObjectReader()) {
			walk.sort(RevSort.COMMIT_TIME_DESC);
			RevCommit start = walk.parseCommit(head);
			walk.markStart(start);
			ObjectId known = this.deletionsHead;
			if (known != null && repository.getObjectDatabase().has(known)
					&& walk.isMergedInto(walk.parseCommit(known), start)) {
				walk.reset();
				walk.markStart(walk.parseCommit(head));
				walk.markUninteresting(walk.parseCommit(known));
			}
			else {
				walk.reset();
				walk.markStart(walk.parseCommit(head));
				this.deletions.clear();
			}
			// Newest first: the first change seen for a path in this range decides it, and overrides what was known.
			Set<String> decided = new HashSet<>();
			for (RevCommit commit = walk.next(); commit != null; commit = walk.next()) {
				RevCommit parent = (commit.getParentCount() > 0) ? walk.parseCommit(commit.getParent(0)) : null;
				for (FileChange change : diff(repository, reader, (parent != null) ? parent.getTree() : null,
						commit.getTree(), null)) {
					if (change.change() == ChangeType.RENAMED && change.renamedFrom() != null
							&& decided.add(change.renamedFrom())) {
						this.deletions.remove(change.renamedFrom());
					}
					if (!decided.add(change.path())) {
						continue;
					}
					if (change.change() == ChangeType.DELETED && parent != null) {
						this.deletions.put(change.path(), new Deletion(change.path(), commit, parent.name()));
					}
					else {
						this.deletions.remove(change.path());
					}
				}
			}
		}
	}

	// ---------------------------------------------------------------- diffs

	/** The visible files that differ between two trees ({@code null} is the empty tree), renames detected. */
	private static List<FileChange> diff(Repository repository, ObjectReader reader, @Nullable ObjectId oldTree,
			ObjectId newTree, @Nullable TreeFilter paths) throws IOException {
		List<DiffEntry> entries;
		try (TreeWalk walk = new TreeWalk(repository, reader)) {
			walk.setRecursive(true);
			walk.addTree(iterator(reader, oldTree));
			walk.addTree(iterator(reader, newTree));
			walk.setFilter((paths != null) ? AndTreeFilter.create(paths, TreeFilter.ANY_DIFF) : TreeFilter.ANY_DIFF);
			entries = DiffEntry.scan(walk);
		}
		Collection<DiffEntry> detected = entries;
		boolean renames = entries.stream().anyMatch((e) -> e.getChangeType() == DiffEntry.ChangeType.ADD)
				&& entries.stream().anyMatch((e) -> e.getChangeType() == DiffEntry.ChangeType.DELETE);
		if (renames) {
			RenameDetector detector = new RenameDetector(reader, repository.getConfig().get(
					org.eclipse.jgit.diff.DiffConfig.KEY));
			detector.addAll(entries);
			try {
				detected = detector.compute(reader, NullProgressMonitor.INSTANCE);
			}
			catch (org.eclipse.jgit.api.errors.CanceledException ex) {
				throw new IOException("Rename detection was canceled", ex);
			}
		}
		List<FileChange> changes = new ArrayList<>();
		for (DiffEntry entry : detected) {
			String path = nfc((entry.getChangeType() == DiffEntry.ChangeType.DELETE) ? entry.getOldPath()
					: entry.getNewPath());
			if (isHidden(path)) {
				continue;
			}
			ChangeType type = switch (entry.getChangeType()) {
				case ADD, COPY -> ChangeType.ADDED;
				case MODIFY -> ChangeType.MODIFIED;
				case DELETE -> ChangeType.DELETED;
				case RENAME -> ChangeType.RENAMED;
			};
			changes.add(new FileChange(path, type,
					(type == ChangeType.RENAMED) ? nfc(entry.getOldPath()) : null));
		}
		changes.sort((a, b) -> a.path().compareToIgnoreCase(b.path()));
		return changes;
	}

	private static AbstractTreeIterator iterator(ObjectReader reader, @Nullable ObjectId tree) throws IOException {
		if (tree == null) {
			return new EmptyTreeIterator();
		}
		CanonicalTreeParser parser = new CanonicalTreeParser();
		parser.reset(reader, tree);
		return parser;
	}

	/** True for paths with a segment starting with a dot: app data and other hidden entries. */
	static boolean isHidden(String path) {
		return path.startsWith(".") || path.contains("/.");
	}

	private static String nfc(String disk) {
		return Normalizer.normalize(disk, Normalizer.Form.NFC);
	}

}
