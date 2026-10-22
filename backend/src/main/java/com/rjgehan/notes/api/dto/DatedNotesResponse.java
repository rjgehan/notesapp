package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code GET /api/notes/by-date}: the notes dated within a range of days, by day, then path (API.md §25.1). */
public record DatedNotesResponse(String from, String to, List<String> properties, List<DatedNote> notes) {
}
