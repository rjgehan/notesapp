package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/capture} (API.md §8.5). {@code target} defaults to inbox. "Today" is decided on the device:
 * {@code date} ({@code YYYY-MM-DD}) and {@code time} ({@code HH:mm}) as shown there, or an IANA {@code tz}; the
 * server's zone is only the fallback.
 */
public record CaptureRequest(@Nullable String text, @Nullable CaptureTarget target, @Nullable String url,
		@Nullable String title, @Nullable String date, @Nullable String time, @Nullable String tz) {
}
