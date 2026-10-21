package com.rjgehan.notes.ops;

import org.jspecify.annotations.Nullable;

/**
 * The stable log markers of DESIGN §5.18, each with the fixed text of its alert. A log message is an alert when its
 * first word is one of these names. The texts are written here, not taken from the log message, so an alert never
 * carries a path, an error text or note content off the server.
 */
public enum AlertMarker {

	GIT_COMMIT_FAILED(4, "History is not being saved",
			"Git commits are failing, so new versions of your notes are not being recorded. The notes themselves are "
					+ "saved, and NotesApp keeps retrying."),

	GIT_MIRROR_FAILED(3, "The history mirror is not being updated",
			"Pushing the history to the mirror failed, the mirror's settings cannot be used, or the mirror has "
					+ "commits this vault does not. NotesApp retries failed pushes, and never force-pushes."),

	WATCHER_DEGRADED(3, "Changes made outside NotesApp appear late",
			"The file watcher failed, so changes made on the server outside the app are only found by the "
					+ "rescan every few minutes."),

	TAILSCALE_WATCHDOG_EXIT(4, "Restarted to rejoin the Tailscale network",
			"NotesApp could not reach the Tailscale container and restarted itself to rejoin its network. After 3 "
					+ "restarts in 10 minutes it stops trying; then run docker compose up -d."),

	STORAGE_LOW(4, "The vault's disk is almost full",
			"Free space on the vault's disk is below the minimum, so uploads are refused until space is freed."),

	SETTINGS_READ_ONLY(3, "Settings are read-only",
			"The settings file was written by a newer NotesApp or is invalid, so settings cannot be changed until "
					+ "it is fixed or the newer version runs again.");

	private final int priority;

	private final String title;

	private final String text;

	AlertMarker(int priority, String title, String text) {
		this.priority = priority;
		this.title = title;
		this.text = text;
	}

	/** ntfy's priority: 4 (high) for problems that need attention soon, 3 (default) for the others. */
	public int priority() {
		return this.priority;
	}

	public String title() {
		return this.title;
	}

	public String text() {
		return this.text;
	}

	/** The marker a log message pattern starts with ({@code "STORAGE_LOW only {} bytes…"}), or null. */
	public static @Nullable AlertMarker of(@Nullable String message) {
		if (message == null || message.isEmpty() || message.charAt(0) < 'A' || message.charAt(0) > 'Z') {
			return null;
		}
		int end = 0;
		while (end < message.length() && isMarkerChar(message.charAt(end))) {
			end++;
		}
		if (end < message.length() && !Character.isWhitespace(message.charAt(end))) {
			return null;
		}
		String word = message.substring(0, end);
		for (AlertMarker marker : values()) {
			if (marker.name().equals(word)) {
				return marker;
			}
		}
		return null;
	}

	private static boolean isMarkerChar(char c) {
		return (c >= 'A' && c <= 'Z') || c == '_';
	}

}
