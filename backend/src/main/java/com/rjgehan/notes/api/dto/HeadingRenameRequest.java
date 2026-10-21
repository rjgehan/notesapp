package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/notes/rename-heading}: {@code dryRun} defaults to false. */
public record HeadingRenameRequest(@Nullable String path, @Nullable String from, @Nullable String to,
		@Nullable Boolean dryRun) {
}
