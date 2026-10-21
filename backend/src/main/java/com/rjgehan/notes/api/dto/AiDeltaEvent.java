package com.rjgehan.notes.api.dto;

/** {@code event: delta} (API.md §24.5): the next piece of the answer. */
public record AiDeltaEvent(String text) {
}
