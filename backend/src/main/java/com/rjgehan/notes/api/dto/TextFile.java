package com.rjgehan.notes.api.dto;

import java.time.Instant;

public record TextFile(String path, FileKind kind, String content, String version, long size, Instant mtime,
		boolean lossy) {
}
