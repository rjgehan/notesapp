package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The note a capture was appended to (or created: {@code created}, with its new folders), and the attachment stored by
 * {@code POST /api/capture/file} (null otherwise).
 */
public record CaptureResult(FileEntry file, boolean created, List<String> createdFolders, CaptureTarget target,
		@Nullable FileEntry attachment) {
}
