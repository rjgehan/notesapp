package com.rjgehan.notes.history;

import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.ChangesResponse;
import com.rjgehan.notes.api.dto.DeletedFile;
import com.rjgehan.notes.api.dto.DeletedFilesResponse;
import com.rjgehan.notes.api.dto.TimelineEntry;
import com.rjgehan.notes.api.dto.TimelineFile;
import com.rjgehan.notes.api.dto.TimelineResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultPaths;
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.revwalk.RevCommit;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * The vault-wide history API (API.md §14.6–14.8, ROADMAP item 28): the timeline of commits, what changed over a
 * period, and deleted files that can be restored with {@code POST /api/history/restore}. Like every history endpoint
 * it answers {@code 503 history-unavailable} while git is disabled, unusable or still importing.
 */
@Service
public class TimelineService {

	private final GitStore git;

	private final GitTimeline timeline;

	private final CommitBatcher batcher;

	private final VaultIndex index;

	private final VaultPaths paths;

	public TimelineService(GitStore git, GitTimeline timeline, CommitBatcher batcher, VaultIndex index,
			VaultPaths paths) {
		this.git = git;
		this.timeline = timeline;
		this.batcher = batcher;
		this.index = index;
		this.paths = paths;
	}

	/** {@code GET /api/history/log}. */
	public TimelineResponse log(@Nullable String path, @Nullable String author, @Nullable String since,
			@Nullable String until, int limit, int offset) throws IOException {
		requireAvailable();
		GitTimeline.Filter filter = new GitTimeline.Filter(diskPath(path), blankToNull(author),
				instant("since", since), instant("until", until));
		GitTimeline.LogPage page = this.timeline.log(filter, offset, limit);
		List<TimelineEntry> entries = new ArrayList<>(page.commits().size());
		for (GitTimeline.CommitChanges changes : page.commits()) {
			RevCommit commit = changes.commit();
			PersonIdent author1 = commit.getAuthorIdent();
			entries.add(new TimelineEntry(commit.name(), commit.abbreviate(7).name(), changes.parentId(),
					author1.getWhenAsInstant(), author1.getName(), author1.getEmailAddress(),
					commit.getShortMessage(), files(changes.files()), changes.filesTotal()));
		}
		return new TimelineResponse(entries, page.hasMore());
	}

	/** {@code GET /api/history/changes}. */
	public ChangesResponse changes(@Nullable String since, @Nullable String until, @Nullable String path)
			throws IOException {
		requireAvailable();
		Instant from = instant("since", since);
		Instant to = instant("until", until);
		if (from != null && to != null && !from.isBefore(to)) {
			throw NotesException.badRequest("since must be before until");
		}
		GitTimeline.Changes changes = this.timeline.changes(from, to, diskPath(path));
		return new ChangesResponse(from, to, changes.fromCommitId(), changes.toCommitId(), changes.commits(),
				changes.authors(), files(changes.files()), changes.truncated());
	}

	/** {@code GET /api/history/deleted}: files deleted in history that do not exist now, newest first. */
	public DeletedFilesResponse deleted(@Nullable String query, int limit, int offset) throws IOException {
		requireAvailable();
		String needle = (query != null && !query.isBlank()) ? PathNames.lower(query.strip()) : null;
		List<DeletedFile> all = new ArrayList<>();
		for (GitTimeline.Deletion deletion : this.timeline.deletions()) {
			if (this.index.file(deletion.path()) != null || this.index.isFolder(deletion.path())) {
				continue;
			}
			if (needle != null && !PathNames.lower(deletion.path()).contains(needle)) {
				continue;
			}
			RevCommit commit = deletion.commit();
			PersonIdent author = commit.getAuthorIdent();
			all.add(new DeletedFile(deletion.path(), author.getWhenAsInstant(), commit.name(),
					commit.abbreviate(7).name(), deletion.parentId(), author.getName(), author.getEmailAddress(),
					commit.getShortMessage()));
		}
		int from = Math.min(offset, all.size());
		int to = Math.min(all.size(), from + limit);
		return new DeletedFilesResponse(List.copyOf(all.subList(from, to)), all.size(), to < all.size());
	}

	private static List<TimelineFile> files(List<GitTimeline.FileChange> changes) {
		return changes.stream().map((c) -> new TimelineFile(c.path(), c.change(), c.renamedFrom())).toList();
	}

	/** The on-disk form of a path filter: the indexed name when the file or folder exists, else as given. */
	private @Nullable String diskPath(@Nullable String path) {
		if (path == null || path.isBlank()) {
			return null;
		}
		String nfc = this.paths.normalize(path.strip());
		String disk = this.index.diskPath(nfc);
		return (disk != null) ? disk : nfc;
	}

	private static @Nullable Instant instant(String name, @Nullable String value) {
		if (value == null || value.isBlank()) {
			return null;
		}
		try {
			return Instant.parse(value.strip());
		}
		catch (DateTimeParseException ex) {
			throw NotesException.badRequest(name + " must be an ISO-8601 instant such as 2026-10-16T00:00:00Z");
		}
	}

	private static @Nullable String blankToNull(@Nullable String value) {
		return (value == null || value.isBlank()) ? null : value.strip();
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

}
