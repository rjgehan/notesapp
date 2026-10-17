package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

public record HistoryContent(String commitId, String path, String version, long size, boolean binary,
		@Nullable String content, boolean lossy) {
}
