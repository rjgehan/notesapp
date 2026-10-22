package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/** A device subscribed to Web Push (API.md §25.2). The endpoint and keys stay on the server. */
public record PushDevice(String id, String name, Instant createdAt, @Nullable Instant lastSuccessAt,
		@Nullable String lastError, @Nullable Instant lastErrorAt) {
}
