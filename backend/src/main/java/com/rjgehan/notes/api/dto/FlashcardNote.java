package com.rjgehan.notes.api.dto;

/** A note that may hold flashcards, with its text (API.md §34.2). */
public record FlashcardNote(String path, String version, String content) {
}
