package com.rjgehan.notes.api.dto;

import java.util.List;

public record DeletedFilesResponse(List<DeletedFile> entries, int total, boolean hasMore) {
}
