package com.rjgehan.notes.api.dto;

/** Token counts of one request, as the Claude API reported them (API.md §24.5). */
public record AiUsage(long inputTokens, long outputTokens, long cacheReadInputTokens, long cacheCreationInputTokens) {
}
