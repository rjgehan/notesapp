package com.rjgehan.notes.api.dto;

import java.util.List;

public record HistoryResponse(String path, boolean pending, boolean hasMore, List<HistoryEntry> entries) {
}
