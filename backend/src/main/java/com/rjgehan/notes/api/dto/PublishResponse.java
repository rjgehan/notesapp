package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/publish} (API.md §26.1). {@code enabled} is {@code notes.publish.enabled}: while it is false
 * nothing is served and nothing can be published, though notes published earlier can still be unpublished.
 */
public record PublishResponse(boolean enabled, @Nullable String baseUrl, List<PublishedNote> notes) {
}
