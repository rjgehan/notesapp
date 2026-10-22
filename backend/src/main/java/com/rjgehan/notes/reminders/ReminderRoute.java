package com.rjgehan.notes.reminders;

import com.rjgehan.notes.settings.RemindersSettings;
import org.jspecify.annotations.Nullable;

/** A way a reminder reaches you (DESIGN §5.26): Web Push, ntfy or in-app. Each is switched on in Settings. */
public interface ReminderRoute {

	/** {@code webPush}, {@code ntfy} or {@code inApp}, as in {@code settings.reminders} and the test endpoint. */
	String id();

	boolean enabled(RemindersSettings settings);

	/** Sends the message; never throws. Accepted means the route took it (a push service, ntfy or an open tab). */
	Delivery deliver(ReminderMessage message, RemindersSettings settings);

	/** What became of one message on one route. */
	record Delivery(boolean accepted, @Nullable String error) {

		static final Delivery ACCEPTED = new Delivery(true, null);

		static Delivery failed(String error) {
			return new Delivery(false, error);
		}

	}

}
