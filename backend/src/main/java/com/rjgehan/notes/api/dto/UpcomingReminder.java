package com.rjgehan.notes.api.dto;

/** One of the next reminders (API.md §28.1): the task, its title and the local date-time. */
public record UpcomingReminder(String taskId, String title, String at) {
}
