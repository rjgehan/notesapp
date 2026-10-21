package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/status/details} (API.md §6.5): what the status page shows beyond {@code GET /api/status}. Some of
 * it costs more to gather (the commit count walks the history), so the status bar never asks for it.
 */
public record StatusDetails(RuntimeStatus runtime, EventsStatus events, GitDetails git, DiskDetails disk,
		BackupStatus backup, AlertsStatus alerts) {

	/** The JVM: its version and vendor, whether it started from the image's AOT cache, and its heap. */
	public record RuntimeStatus(String javaVersion, String javaVendor, AotCacheState aotCache, long heapUsedBytes,
			long heapMaxBytes, int processors) {
	}

	/** {@code clients}: the open live-sync (SSE) connections, one per open tab or app window. */
	public record EventsStatus(int clients) {
	}

	/**
	 * {@code commits}: the commits in the history, null when history is off. The counters cover this server run.
	 * {@code largeFiles} are the files kept out of history (largest first, at most 100; {@code largeFilesTruncated}
	 * when there are more).
	 */
	public record GitDetails(@Nullable Long commits, long commitsThisRun, long failedCommitsThisRun,
			List<LargeFile> largeFiles, boolean largeFilesTruncated) {
	}

	public record LargeFile(String path, long bytes) {
	}

	/** {@code totalBytes}: the size of the vault's filesystem, null when it cannot be read. */
	public record DiskDetails(@Nullable Long totalBytes) {
	}

}
