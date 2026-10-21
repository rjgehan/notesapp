package com.rjgehan.notes.api.dto;

import java.util.Map;

/** The simple frontmatter values of a note in the daily-notes folder (API.md §35.1). */
public record DailyNoteValues(String path, Map<String, Object> values) {
}
