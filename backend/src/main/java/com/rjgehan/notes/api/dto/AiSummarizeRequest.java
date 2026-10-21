package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/ai/summarize} (API.md §20.3). {@code action} is {@code summarize} (the default) or {@code suggest}
 * (links, tags and tasks for a note). {@code scope}: {@code note} ({@code path}), {@code folder} ({@code path}),
 * {@code notes} ({@code paths}, e.g. this week's daily notes, described by {@code label}) or {@code selection}
 * ({@code text}, taken from the note at {@code path}).
 */
public record AiSummarizeRequest(@Nullable String action, @Nullable String scope, @Nullable String path,
		@Nullable List<String> paths, @Nullable String text, @Nullable String label, @Nullable List<AiTurn> history) {
}
