package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/notes/block-id} (API.md §37): {@code line} is the 0-based line the client read {@code lineText}
 * on; {@code placement} is {@code "end"} or {@code "after"}; {@code id} is the id the client would like (optional).
 */
public record BlockIdRequest(@Nullable String path, @Nullable Integer line, @Nullable String lineText,
		@Nullable String placement, @Nullable String id) {
}
