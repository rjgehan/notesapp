package com.rjgehan.notes.api.dto;

/** A named search query (API.md §12.4). {@code sort} is {@code relevance} or {@code mtime}. */
public record SavedSearch(String id, String name, String query, String sort) {
}
