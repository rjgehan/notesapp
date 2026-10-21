package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/** One commit of the vault-wide timeline; {@code files} holds at most 100 of {@code filesTotal} (API.md §14.6). */
public record TimelineEntry(String commitId, String shortId, @Nullable String parentCommitId, Instant time,
		String authorName, String authorLogin, String message, List<TimelineFile> files, int filesTotal) {
}
