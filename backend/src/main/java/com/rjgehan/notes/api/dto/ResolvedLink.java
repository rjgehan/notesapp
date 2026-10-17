package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

public record ResolvedLink(@Nullable String path, @Nullable String createPath) {
}
