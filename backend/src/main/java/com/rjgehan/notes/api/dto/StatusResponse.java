package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/** {@code GET /api/status} (API.md §6.2); {@code eventId} is read before the snapshot is taken. */
public record StatusResponse(String appVersion, String buildSha, String bootId, Instant startedAt, String eventId,
		VaultStats vault, IndexStats index, GitStatus git, WatcherStatus watcher, DiskStatus disk,
		SettingsStatus settings) {

	public record VaultStats(int notes, int files, int folders, long bytes, List<SkippedEntry> skipped,
			List<String> unwritableDirs) {
	}

	public record IndexStats(long builtInMs, @Nullable Instant lastRescanAt) {
	}

	public record GitStatus(boolean enabled, GitState state, @Nullable String reason, @Nullable String head,
			int pendingPaths, @Nullable Instant nextCommitAt, @Nullable Instant lastCommitAt, @Nullable String lastError,
			@Nullable Instant failingSince) {
	}

	public record WatcherStatus(WatcherMode mode) {
	}

	/** {@code repoBytes} is the size of {@code .git} measured by the last rescan, null before the first one. */
	public record DiskStatus(long freeBytes, @Nullable Long repoBytes) {
	}

	public record SettingsStatus(boolean readOnly, @Nullable String reason) {
	}

}
