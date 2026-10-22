package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code PUT /api/reminders/zone} (API.md §28.1): the device's IANA time zone, such as {@code Europe/Berlin}. */
public record ReminderZoneRequest(@Nullable String zone) {
}
