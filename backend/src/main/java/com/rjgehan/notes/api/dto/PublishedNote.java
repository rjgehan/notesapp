package com.rjgehan.notes.api.dto;

import java.time.Instant;

/**
 * One published note (API.md §26.1). {@code url} is the public address: {@code notes.publish.base-url} followed by
 * {@code /p/<slug>}, or only the path when no base URL is configured.
 */
public record PublishedNote(String path, String slug, String title, String url, Instant publishedAt,
		PublishedNoteState state) {
}
