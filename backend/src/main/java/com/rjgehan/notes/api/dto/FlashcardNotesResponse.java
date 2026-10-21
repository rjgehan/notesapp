package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code GET /api/flashcards/notes}. */
public record FlashcardNotesResponse(FlashcardConfig config, List<FlashcardNote> notes) {
}
