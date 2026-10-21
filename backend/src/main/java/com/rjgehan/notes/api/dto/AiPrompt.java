package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * What a turn asked (API.md §20.1): {@code action} {@code ask} with its {@code question}, or {@code summarize} /
 * {@code suggest} with the fields of {@link AiSummarizeRequest}.
 */
public record AiPrompt(@Nullable String action, @Nullable String question, @Nullable String scope,
		@Nullable String path, @Nullable List<String> paths, @Nullable String text, @Nullable String label) {
}
