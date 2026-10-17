package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

/** A missing {@code baseVersion} means null ("create"); {@code flushHistory} defaults to false. */
public record SaveFileRequest(@NotNull String content, @Nullable String baseVersion, @Nullable Boolean flushHistory) {
}
