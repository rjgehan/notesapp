package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/alerts/test} (API.md §6.6): whether ntfy accepted the test alert, and if not, why. */
public record AlertTestResult(boolean sent, @Nullable String error) {
}
