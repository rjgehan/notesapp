package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/ai/status} (API.md §20.4): whether Ask and summaries can be used, through which provider, and this
 * month's estimated spend. {@code keyFile} is the name of the selected provider's credential file (the Claude Code
 * token or the API key), never its content; {@code cliInstalled} says whether the Claude Code CLI is on the server;
 * {@code fake} is true on a development server that answers without Claude.
 */
public record AiStatus(AiState state, @Nullable String reason, String provider, String model,
		List<AiModelInfo> models, String keyFile, boolean keyPresent, boolean cliInstalled, String month,
		double monthCostUsd, int monthRequests, double monthlyBudgetUsd, int maxContextChars, boolean fake) {
}
