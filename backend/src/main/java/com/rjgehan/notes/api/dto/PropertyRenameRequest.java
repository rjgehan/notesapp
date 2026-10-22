package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** Renames a property in every note (API.md §38.4). */
public record PropertyRenameRequest(@Nullable String from, @Nullable String to, @Nullable Boolean dryRun) {
}
