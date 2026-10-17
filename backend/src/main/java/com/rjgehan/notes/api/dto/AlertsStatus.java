package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * App-error alerts (ROADMAP item 38, API.md §6.5). {@code server} is the ntfy server's URL, never the topic or the
 * token. {@code sent} and {@code dropped} (held back by the rate limit) cover this server run. {@code recent} counts
 * the markers logged since the server started, whether or not alerts are on, most recent first.
 */
public record AlertsStatus(AlertsState state, @Nullable String reason, @Nullable String server, long sent,
		long dropped, @Nullable Instant lastSentAt, @Nullable String lastError, @Nullable Instant lastErrorAt,
		List<MarkerCount> recent) {

	public record MarkerCount(String marker, long count, Instant lastAt) {
	}

}
