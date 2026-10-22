package com.rjgehan.notes.reminders;

import org.jspecify.annotations.Nullable;

/**
 * One notification, as every route receives it.
 *
 * @param key identifies the reminder: {@code task:<id>:<at>}, {@code snooze:<id>:<at>:<epoch second>},
 * {@code daily:<date>} or {@code test:<epoch millis>}
 * @param kind {@code task}, {@code daily} or {@code test}
 * @param taskId the task, for task reminders (the notification's Snooze and Done act on it)
 * @param at the reminder's local date-time as stored on the task, for task reminders
 * @param title the task's title, or the nudge's
 * @param body the details: when it is due and the start of its notes
 * @param url the app path that opens it, such as {@code /x/tasks/today?task=<id>}
 */
public record ReminderMessage(String key, String kind, @Nullable String taskId, @Nullable String at, String title,
		String body, String url) {

	/** ntfy with "title only": the task's title, and a body that names nothing from the vault. */
	/** The same message opening {@code prefix + url}: an extra vault's reminders open that vault (DESIGN §5.38). */
	ReminderMessage withUrlPrefix(String prefix) {
		return prefix.isEmpty() ? this
				: new ReminderMessage(this.key, this.kind, this.taskId, this.at, this.title, this.body, prefix + this.url);
	}

	ReminderMessage titleOnly() {
		String generic = switch (this.kind) {
			case "daily" -> "Daily note";
			case "test" -> "Test";
			default -> "Task reminder";
		};
		return new ReminderMessage(this.key, this.kind, this.taskId, this.at, this.title, generic, this.url);
	}

}
