package com.rjgehan.notes.api.dto;

import java.time.Instant;

/** One top-level item of {@code .trash/}; ids starting with {@code x-} were not trashed through NotesApp. */
public record TrashEntry(String id, String originalPath, EntryType type, Instant deletedAt, String deletedBy,
		long size, int fileCount) {
}
