package com.rjgehan.notes.api;

import java.io.IOException;
import java.util.Comparator;
import java.util.List;

import com.rjgehan.notes.api.dto.StatusDetails;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.history.LargeFiles;
import com.rjgehan.notes.ops.AppAlerts;
import com.rjgehan.notes.ops.BackupStatusReader;
import com.rjgehan.notes.ops.RuntimeInfo;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/status/details} (API.md §6.5): the rest of what the status page shows (ROADMAP item 38). The commit
 * count walks the whole history, so it is cached per {@code HEAD}; everything else is read on each request.
 */
@RestController
public class StatusDetailsController {

	static final int MAX_LARGE_FILES = 100;

	private record CommitCount(String head, long commits) {
	}

	private final RuntimeInfo runtime;

	private final EventHub hub;

	private final GitStore git;

	private final CommitBatcher batcher;

	private final LargeFiles largeFiles;

	private final VaultFs fs;

	private final BackupStatusReader backup;

	private final AppAlerts alerts;

	private volatile @Nullable CommitCount commitCount;

	public StatusDetailsController(RuntimeInfo runtime, EventHub hub, GitStore git, CommitBatcher batcher,
			LargeFiles largeFiles, VaultFs fs, BackupStatusReader backup, AppAlerts alerts) {
		this.runtime = runtime;
		this.hub = hub;
		this.git = git;
		this.batcher = batcher;
		this.largeFiles = largeFiles;
		this.fs = fs;
		this.backup = backup;
		this.alerts = alerts;
	}

	@GetMapping("/api/status/details")
	StatusDetails details() {
		return new StatusDetails(this.runtime.status(), new StatusDetails.EventsStatus(this.hub.connectionCount()),
				gitDetails(), new StatusDetails.DiskDetails(totalSpace()), this.backup.read(), this.alerts.status());
	}

	private StatusDetails.GitDetails gitDetails() {
		CommitBatcher.Status status = this.batcher.status();
		List<LargeFiles.Entry> large = this.largeFiles.current()
			.files()
			.stream()
			.sorted(Comparator.comparingLong(LargeFiles.Entry::size).reversed().thenComparing(LargeFiles.Entry::path))
			.toList();
		List<StatusDetails.LargeFile> shown = large.stream()
			.limit(MAX_LARGE_FILES)
			.map((entry) -> new StatusDetails.LargeFile(entry.path(), entry.size()))
			.toList();
		return new StatusDetails.GitDetails(commits(), status.commitsThisRun(), status.failedCommitsThisRun(), shown,
				large.size() > shown.size());
	}

	/** The commits in the history, null when history is off or cannot be read. */
	private @Nullable Long commits() {
		if (!this.git.isEnabled()) {
			return null;
		}
		try {
			String head = this.git.head();
			if (head == null) {
				return 0L;
			}
			CommitCount cached = this.commitCount;
			if (cached != null && cached.head().equals(head)) {
				return cached.commits();
			}
			long count = this.git.commitCount(head);
			this.commitCount = new CommitCount(head, count);
			return count;
		}
		catch (IOException | RuntimeException ex) {
			return null;
		}
	}

	private @Nullable Long totalSpace() {
		try {
			return this.fs.totalSpace();
		}
		catch (IOException ex) {
			return null;
		}
	}

}
