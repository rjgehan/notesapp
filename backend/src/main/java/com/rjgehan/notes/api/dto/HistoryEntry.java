package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

public record HistoryEntry(String commitId, String shortId, @Nullable String parentCommitId, String path,
		Instant time, String authorName, String authorLogin, String message, ChangeType change,
		@Nullable String renamedFrom) {
}
