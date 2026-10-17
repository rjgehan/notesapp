package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The result of a list change: the lists after it, the list files written (to apply to the client's tree like
 * {@code file.created} or {@code file.changed}), the file move a rename made, and the trash entry of a deleted list.
 */
public record TaskListWriteResult(List<TaskList> lists, List<FileEntry> files, List<String> createdFolders,
		@Nullable MovedFile moved, @Nullable TrashEntry trash) {
}
