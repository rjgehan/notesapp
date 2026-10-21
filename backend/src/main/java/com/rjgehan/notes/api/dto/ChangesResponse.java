package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The net change of the vault between two points in time (API.md §14.7): the files that differ between commit
 * {@code fromCommitId} (null: the beginning) and {@code toCommitId}, and the commits and authors in between.
 */
public record ChangesResponse(@Nullable Instant since, @Nullable Instant until, @Nullable String fromCommitId,
		@Nullable String toCommitId, int commits, List<String> authors, List<TimelineFile> files,
		boolean truncated) {
}
