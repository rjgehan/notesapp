package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotBlank;

/** {@code POST /api/transcriptions} (API.md §20.2): the vault path of an audio or video file. */
public record TranscribeRequest(@NotBlank String path) {
}
