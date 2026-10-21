package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * A task list: one {@code .tasks} file. {@code path} is the file; {@code writable} is false when the file was written
 * by a newer version of NotesApp, which this version only reads.
 */
public record TaskList(String id, String name, @Nullable String color, @Nullable String icon, String order,
		boolean archived, List<TaskSection> sections, String path, boolean writable) {
}
