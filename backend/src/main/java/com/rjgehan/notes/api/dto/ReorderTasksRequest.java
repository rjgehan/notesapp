package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/tasks/reorder}: places {@code ids}, in this order, right after {@code after} (null: first) among
 * the tasks of {@code listId} under {@code parentId} (null: top level) and, for top-level tasks, in {@code sectionId}.
 */
public record ReorderTasksRequest(@Nullable String listId, @Nullable String sectionId, @Nullable String parentId,
		@Nullable List<String> ids, @Nullable String after) {
}
