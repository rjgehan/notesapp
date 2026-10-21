package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code GET /api/tasks}: the view's tasks, every list, and the problems found in task files. */
public record TasksResponse(TaskView view, List<TaskList> lists, List<Task> tasks, int total,
		List<TaskFileProblem> problems) {
}
