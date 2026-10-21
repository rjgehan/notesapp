package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/transcription} (API.md §23.1): whether voice notes can be transcribed. {@code service} is the
 * protocol and the service's address without credentials or path ({@code "whisper-asr at http://notesapp-whisper:9000"}),
 * {@code language} the configured one (null: detected), {@code maxBytes} the largest recording that is sent.
 */
public record TranscriptionStatus(boolean enabled, @Nullable String service, @Nullable String language, long maxBytes) {
}
