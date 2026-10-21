package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

public record FlashcardReviewRequest(@Nullable List<FlashcardReview> reviews) {
}
