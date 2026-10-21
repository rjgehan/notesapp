package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * One card's review record (API.md §34.1). {@code reviews} are {@code "<instant> <rating>[ <ms>]"} strings, oldest
 * first; {@code note} and {@code front} are hints from the last review (where the card was, and the start of its
 * question).
 */
public record FlashcardCard(@Nullable String note, @Nullable String front, @Nullable FlashcardCardState state,
		List<String> reviews) {
}
