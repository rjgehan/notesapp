package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code BackupStatus.state} (API.md §6.5). */
public enum BackupState {

	/** No backup status is visible to the app: backups are not set up, or their state is not mounted. */
	@JsonProperty("unknown") UNKNOWN,

	/** The last run worked, recently enough. */
	@JsonProperty("ok") OK,

	/** The last run failed; {@code failures} says what. */
	@JsonProperty("failed") FAILED,

	/** The last success is older than {@code notes.backup.stale-after} (36 hours): runs have stopped. */
	@JsonProperty("stale") STALE

}
