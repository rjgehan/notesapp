package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.jspecify.annotations.Nullable;

/**
 * A note matching {@code GET /api/notes/query} (API.md §40.1): its metadata from the index, the vault paths its
 * links resolve to, and, on request, its checkbox tasks.
 */
public record QueriedNote(String path, String title, List<String> aliases, List<String> tags,
		@Nullable Map<String, @Nullable Object> frontmatter, Instant mtime, long size, List<String> links,
		@Nullable List<NoteTask> tasks) {
}
