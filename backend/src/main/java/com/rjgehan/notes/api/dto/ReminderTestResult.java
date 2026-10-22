package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code POST /api/reminders/test} (API.md §28.3): whether the route accepted the test, and if not, why. */
public record ReminderTestResult(boolean sent, @Nullable String error) {
}
