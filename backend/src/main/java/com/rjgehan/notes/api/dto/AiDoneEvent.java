package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code event: done} (API.md §20.5): how the answer ended ({@code stopReason} {@code end_turn}, {@code max_tokens},
 * {@code refusal}, …), the model that wrote it, the tokens and the estimated cost of this request and of the month.
 */
public record AiDoneEvent(String model, String stopReason, @Nullable String refusalCategory, boolean fellBack,
		AiUsage usage, double costUsd, double monthCostUsd) {
}
