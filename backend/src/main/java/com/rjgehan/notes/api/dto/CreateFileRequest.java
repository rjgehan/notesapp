package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

public record CreateFileRequest(@NotNull String path, @Nullable String content, @Nullable OnConflict onConflict) {
}
