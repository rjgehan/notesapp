package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/publish} (API.md §26.2): publishes or republishes the note at {@code path}. {@code slug} and
 * {@code title} default to the current ones, or for a first publish to ones made from the note's name.
 */
public record PublishRequest(@Nullable String path, @Nullable String slug, @Nullable String title) {
}
