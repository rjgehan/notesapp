package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * One answer in {@code POST /api/flashcards/reviews}. {@code from} names the card's previous id when the card's text
 * was edited, so its record moves to {@code card}.
 */
public record FlashcardReview(@Nullable String card, @Nullable String at, @Nullable String rating, @Nullable Integer ms,
		@Nullable String note, @Nullable String front, @Nullable FlashcardCardState state, @Nullable String from) {
}
