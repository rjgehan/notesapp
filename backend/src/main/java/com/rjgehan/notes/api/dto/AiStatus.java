package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/ai/status} (API.md §20.4): whether Ask and summaries can be used, and this month's estimated spend.
 * {@code keyFile} is the name of the key file, never its content; {@code fake} is true on a development server that
 * answers without Anthropic.
 */
public record AiStatus(AiState state, @Nullable String reason, String model, List<AiModelInfo> models,
		String keyFile, boolean keyPresent, String month, double monthCostUsd, int monthRequests,
		double monthlyBudgetUsd, int maxContextChars, boolean fake) {
}
