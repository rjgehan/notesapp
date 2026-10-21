package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/**
 * The nightly backups (ROADMAP item 1) as the status page shows them (API.md §6.5), from the last run's
 * {@code status.json}. {@code reason} explains an {@code unknown} state; {@code snapshot} is the restic snapshot id,
 * {@code offsite} the off-site result ({@code ok}, {@code off} or {@code failed}) and {@code failures} the failed steps
 * of the last run.
 */
public record BackupStatus(BackupState state, @Nullable String reason, @Nullable Instant lastRun,
		@Nullable Instant lastSuccess, @Nullable String snapshot, @Nullable String offsite, @Nullable String failures) {

	public static BackupStatus unknown(String reason) {
		return new BackupStatus(BackupState.UNKNOWN, reason, null, null, null, null, null);
	}

}
