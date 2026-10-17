package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code to} defaults to the original path; {@code onConflict} to {@code fail}. */
public record RestoreRequest(@Nullable String to, @Nullable OnConflict onConflict) {
}
