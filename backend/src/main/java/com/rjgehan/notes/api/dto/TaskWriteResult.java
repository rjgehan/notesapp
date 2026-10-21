package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The result of a task change. {@code files} are the list files written; the client applies them to its tree as it
 * would {@code file.changed}, because it receives no echo of its own change. {@code lists} are the lists the change
 * created (the Inbox, made the first time a task goes there), whose {@code list.changed} the client does not receive
 * either.
 */
public record TaskWriteResult(@Nullable Task task, List<Task> changed, List<String> deleted, boolean rolledForward,
		List<FileEntry> files, List<String> createdFolders, List<TaskList> lists) {
}
