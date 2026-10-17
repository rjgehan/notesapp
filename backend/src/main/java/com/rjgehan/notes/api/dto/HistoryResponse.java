package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** {@code excluded} is set when new versions of the file are kept out of history (the large-file policy). */
public record HistoryResponse(String path, boolean pending, boolean hasMore, List<HistoryEntry> entries,
		@Nullable HistoryExclusion excluded) {
}
