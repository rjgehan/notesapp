package com.rjgehan.notes.settings;

import java.util.regex.Pattern;

/**
 * {@code settings.reminders}: how task reminders and daily-note nudges reach you (ROADMAP items 9 and 4c, API.md §5,
 * DESIGN §5.26). Every delivery route is off by default and switched on here; a reminder is delivered once at least
 * one route that is on accepts it.
 *
 * @param webPush Web Push to the devices subscribed in Settings › Reminders (the installed app on iOS 16.4+)
 * @param ntfy ntfy, through the server and topic of {@code /data/secrets/ntfy.json}
 * @param ntfyTitleOnly with ntfy, send the task's title only, never its notes or list (on by default, because with
 * ntfy.sh the text leaves the tailnet)
 * @param inApp a toast and a browser notification in every open NotesApp tab
 * @param dailyNote a nudge at {@code dailyNoteTime} when today's daily note does not exist yet
 * @param dailyNoteTime the nudge's local time, {@code HH:mm}
 */
public record RemindersSettings(boolean webPush, boolean ntfy, boolean ntfyTitleOnly, boolean inApp,
		boolean dailyNote, String dailyNoteTime) {

	/** {@code HH:mm}, 00:00 to 23:59. */
	public static final Pattern TIME = Pattern.compile("([01][0-9]|2[0-3]):[0-5][0-9]");

	public static RemindersSettings defaults() {
		return new RemindersSettings(false, false, true, false, false, "09:00");
	}

	/** True when at least one delivery route is switched on. */
	public boolean anyRoute() {
		return this.webPush || this.ntfy || this.inApp;
	}

}
