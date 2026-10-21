package com.rjgehan.notes.api.dto;

/**
 * {@code event: restart} (API.md §20.5): the model declined part way and {@code model} (the server-side fallback)
 * answers from the start; the text received so far is void.
 */
public record AiRestartEvent(String model) {
}
