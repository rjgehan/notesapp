package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/** {@code PUT /api/flashcards/config}: the fields to change; missing fields keep their value. */
public record FlashcardConfigUpdateRequest(@Nullable JsonNode config) {
}
