package com.rjgehan.notes.api.dto;

import java.time.Instant;

import org.jspecify.annotations.Nullable;

/**
 * The git mirror (API.md §6.2, §6.4): {@code StatusResponse.mirror} and the answer to {@code POST /api/mirror/push}.
 * {@code remote} never contains credentials; {@code pushedCommit} and {@code lastPushAt} cover this server run.
 */
public record MirrorStatus(MirrorState state, @Nullable String reason, @Nullable String remote,
		@Nullable String branch, boolean pushing, @Nullable String pushedCommit, @Nullable Instant lastPushAt,
		@Nullable Instant nextPushAt, @Nullable String lastError, @Nullable Instant failingSince) {
}
