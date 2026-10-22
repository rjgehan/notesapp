package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/reminders/status} (API.md §25.1): the time zone reminders are read in, each delivery route's
 * readiness (whether it is switched on is in {@code settings.reminders}), the last delivery and the next reminders.
 */
public record RemindersStatus(String zone, boolean zoneReported, String serverZone, WebPush webPush, Ntfy ntfy,
		InApp inApp, @Nullable Instant lastDeliveredAt, @Nullable String lastError, @Nullable Instant lastErrorAt,
		List<UpcomingReminder> upcoming) {

	/** {@code available} is false when {@code push.json} cannot be used; {@code publicKey} is null until created. */
	public record WebPush(boolean available, @Nullable String reason, @Nullable String publicKey,
			List<PushDevice> devices) {
	}

	/** {@code configured}: {@code ntfy.json} is usable; {@code ownTopic}: it names a topic for reminders. */
	public record Ntfy(boolean configured, @Nullable String reason, @Nullable String server, boolean ownTopic) {
	}

	/** {@code connections}: the open event streams, each a tab that would show an in-app reminder. */
	public record InApp(int connections) {
	}

}
