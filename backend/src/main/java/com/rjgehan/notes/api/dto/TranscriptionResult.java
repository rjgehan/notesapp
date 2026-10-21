package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * The transcript of a recording (API.md §23.2): its {@code text} (empty when no speech was recognized), the language
 * when the service reports one, and the service's time in milliseconds ({@code 0} for a transcript the server had
 * kept from an earlier request).
 */
public record TranscriptionResult(String path, String text, @Nullable String language, long millis) {
}
