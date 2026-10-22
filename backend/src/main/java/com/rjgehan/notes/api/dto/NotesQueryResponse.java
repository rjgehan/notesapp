package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * {@code GET /api/notes/query} (API.md §40.1): the matching notes in path order, at most {@code limit};
 * {@code total} counts every match.
 */
public record NotesQueryResponse(List<QueriedNote> notes, int total, boolean truncated) {
}
