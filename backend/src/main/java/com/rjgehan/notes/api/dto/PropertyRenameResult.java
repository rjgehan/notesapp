package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/** The notes whose property {@code from} was renamed to {@code to} (API.md §38.4). */
public record PropertyRenameResult(boolean dryRun, String from, String to, List<PropertyUpdate> updates,
		List<FailedUpdate> failed, boolean typeMoved, @Nullable String commitId) {
}
