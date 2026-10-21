package com.rjgehan.notes.api.dto;

import java.util.Map;

import org.jspecify.annotations.Nullable;

/** The records a write changed; {@code null} for a record it removed. {@code version} is the file's new blob id. */
public record FlashcardWriteResult(Map<String, @Nullable FlashcardCard> cards, String version) {
}
