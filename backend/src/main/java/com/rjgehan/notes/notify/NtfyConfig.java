package com.rjgehan.notes.notify;

import java.net.URI;

import org.jspecify.annotations.Nullable;

/**
 * Where NotesApp posts ntfy notifications: the server, the default topic and an optional access token, read from
 * {@code ntfy.json} in the secrets directory ({@link NtfyConfigFile}, DESIGN §4.1). The file is shared by every sender:
 * the app-error alerts of ROADMAP item 38 use {@link #alerts()}, and the reminders of item 9 use
 * {@link #remindersTopic()} (the default topic unless {@code "reminders": {"topic": …}} names its own). On a public
 * server such as ntfy.sh the topic works like a password, so neither it nor the token is ever logged or shown;
 * {@link #toString()} leaves both out.
 */
public record NtfyConfig(URI server, String topic, @Nullable String token, Alerts alerts, String remindersTopic) {

	/** A configuration whose reminders go to the default topic. */
	public NtfyConfig(URI server, String topic, @Nullable String token, Alerts alerts) {
		this(server, topic, token, alerts, topic);
	}

	/** The app-error alerts: on unless switched off in the file, sent to the default topic unless one is given. */
	public record Alerts(boolean enabled, String topic) {

		@Override
		public String toString() {
			return "Alerts[enabled=" + this.enabled + "]";
		}

	}

	@Override
	public String toString() {
		return "NtfyConfig[server=" + this.server + "]";
	}

}
