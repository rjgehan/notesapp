package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/**
 * A card's FSRS state after its first {@code n} reviews, as a client computed it (API.md §34.1). It is a cache: the
 * server keeps it only while {@code n} equals the number of reviews and {@code lastReview} is the time of the last one.
 */
public record FlashcardCardState(Instant due, double stability, double difficulty, int scheduledDays,
		int learningSteps, int reps, int lapses, FlashcardPhase phase, @Nullable Instant lastReview, int n) {
}
