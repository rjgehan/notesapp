package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/flashcards/undo}: removes the review at {@code at}; {@code state} is the card's state before it. */
public record FlashcardUndoRequest(@Nullable String card, @Nullable String at, @Nullable FlashcardCardState state) {
}
