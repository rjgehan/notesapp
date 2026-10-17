package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code commitId} is the last commit made: null for a dry run, disabled git, nothing to commit, or a failed commit.
 */
public record MoveResult(boolean dryRun, EntryType type, String from, String to, List<MovedFile> moved,
		List<String> createdFolders, List<LinkUpdate> linkUpdates, List<FailedUpdate> failed,
		@Nullable String commitId) {
}
