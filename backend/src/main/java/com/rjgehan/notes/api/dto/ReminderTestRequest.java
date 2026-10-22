package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/reminders/test} (API.md §28.3): {@code route} is {@code webPush}, {@code ntfy} or {@code inApp};
 * with {@code webPush}, {@code deviceId} limits the test to one device.
 */
public record ReminderTestRequest(@Nullable String route, @Nullable String deviceId) {
}
