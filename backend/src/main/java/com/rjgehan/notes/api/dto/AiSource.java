package com.rjgehan.notes.api.dto;

/**
 * A note sent with a request (API.md §24.5): its path, how many characters of it were sent, and whether that was only
 * part of it.
 */
public record AiSource(String path, int chars, boolean truncated) {
}
