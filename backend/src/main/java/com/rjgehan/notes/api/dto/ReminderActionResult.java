package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/**
 * The answer of a reminder action (API.md §25.4): {@code changed} is false when nothing was done because the task is
 * closed or no longer has this reminder (another device acted first); {@code until} is when a snooze fires.
 */
public record ReminderActionResult(boolean changed, @Nullable Instant until) {
}
