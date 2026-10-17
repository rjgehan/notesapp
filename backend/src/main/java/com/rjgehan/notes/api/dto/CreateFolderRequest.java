package com.rjgehan.notes.api.dto;

import jakarta.validation.constraints.NotNull;

public record CreateFolderRequest(@NotNull String path) {
}
