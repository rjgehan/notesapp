package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/push/subscriptions} (API.md §25.2): what the browser's {@code PushSubscription.toJSON()} gives,
 * plus a name for the device list.
 */
public record PushSubscriptionRequest(@Nullable String endpoint, @Nullable Keys keys, @Nullable String name) {

	public record Keys(@Nullable String p256dh, @Nullable String auth) {
	}

}
