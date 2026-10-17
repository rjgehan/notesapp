package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

public record HistoryRestoreRequest(@NotNull String path, @NotNull String commit, @Nullable String sourcePath,
		@Nullable String baseVersion) {
}
