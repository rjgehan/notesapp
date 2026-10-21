package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The links (and heading bookmarks) updated after a heading of {@code path} was renamed from {@code from} to
 * {@code to}; like {@link MoveResult}, {@code linkUpdates} versions are null in a dry run.
 */
public record HeadingRenameResult(boolean dryRun, String path, String from, String to, List<LinkUpdate> linkUpdates,
		List<FailedUpdate> failed, int bookmarks, @Nullable String commitId) {
}
