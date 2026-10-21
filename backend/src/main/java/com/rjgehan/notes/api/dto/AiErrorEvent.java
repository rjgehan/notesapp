package com.rjgehan.notes.api.dto;

/**
 * {@code event: error} (API.md §20.5): the request failed after the stream started. {@code code}: {@code auth},
 * {@code rate-limited}, {@code overloaded}, {@code bad-request}, {@code unavailable} or {@code internal-error}.
 * {@code message} never contains the API key or note text.
 */
public record AiErrorEvent(String code, String message) {
}
