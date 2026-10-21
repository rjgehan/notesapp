package com.rjgehan.notes.api.dto;

import java.util.Map;

import org.jspecify.annotations.Nullable;

/** {@code GET /api/flashcards}: the settings and every card's review record. */
public record FlashcardsResponse(FlashcardConfig config, Map<String, FlashcardCard> cards, @Nullable String version) {
}
