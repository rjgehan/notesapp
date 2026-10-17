package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

/** {@code updateLinks} defaults to {@code settings.files.autoUpdateLinks}; {@code dryRun} to false. */
public record MoveRequest(@NotNull String from, @NotNull String to, @Nullable Boolean updateLinks,
		@Nullable Boolean dryRun) {
}
