package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** A note whose links were (or, in a dry run, would be) rewritten; {@code path} is post-move. */
public record LinkUpdate(String path, int links, @Nullable String version) {
}
