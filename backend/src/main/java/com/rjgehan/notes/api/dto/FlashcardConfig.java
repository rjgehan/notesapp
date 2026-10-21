package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * The flashcard settings kept in {@code .notesapp/srs.json} (API.md §34.1). Responses always carry every field, with
 * the defaults filled in.
 */
public record FlashcardConfig(List<String> tags, boolean foldersAsDecks, int newPerDay, int reviewsPerDay,
		double retention, int maximumInterval, List<String> learningSteps, List<String> relearningSteps, boolean fuzz,
		int dayStartsAt) {

	public static final FlashcardConfig DEFAULTS = new FlashcardConfig(List.of("flashcards"), false, 20, 200, 0.9,
			36500, List.of("1m", "10m"), List.of("10m"), true, 4);

}
