package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * Something in a {@code .tasks} file that the server cannot use: the whole file ({@code taskId} null) or one task.
 * The server never rewrites a file to "fix" it.
 */
public record TaskFileProblem(String path, @Nullable String taskId, String reason) {
}
