package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code PublishedNote.state} (API.md §26.1). */
public enum PublishedNoteState {

	/** The snapshot shows the note as it is now. */
	@JsonProperty("current") CURRENT,

	/** The note changed since it was published; the public page still shows the snapshot. */
	@JsonProperty("changed") CHANGED,

	/** The note is gone (deleted, or moved outside the app); the snapshot stays public until unpublished. */
	@JsonProperty("source-missing") SOURCE_MISSING,

	/** The snapshot is not on disk (for example after a restore); republish to serve the note again. */
	@JsonProperty("snapshot-missing") SNAPSHOT_MISSING

}
