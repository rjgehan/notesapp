package com.rjgehan.notes.api.dto;

import java.util.List;

public record TaskListsResponse(List<TaskList> lists, List<TaskFileProblem> problems) {
}
