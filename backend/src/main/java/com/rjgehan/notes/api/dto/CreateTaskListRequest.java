package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

public record CreateTaskListRequest(@Nullable String name, @Nullable String color, @Nullable String icon) {
}
