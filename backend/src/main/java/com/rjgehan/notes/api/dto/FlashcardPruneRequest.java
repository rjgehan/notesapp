package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/flashcards/prune}: forgets the records of cards that no longer exist in any note. */
public record FlashcardPruneRequest(@Nullable List<String> cards) {
}
