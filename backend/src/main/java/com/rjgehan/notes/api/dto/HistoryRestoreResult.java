package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code commitId} is null only when the restore commit failed and is being retried (the paths stay pending).
 */
public record HistoryRestoreResult(FileEntry file, boolean created, List<String> createdFolders,
		@Nullable String commitId) {
}
