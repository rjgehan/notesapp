package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** The saved searches and the version of {@code .notesapp/searches.json}, or null while it does not exist. */
public record SavedSearchesResponse(List<SavedSearch> searches, @Nullable String version) {
}
