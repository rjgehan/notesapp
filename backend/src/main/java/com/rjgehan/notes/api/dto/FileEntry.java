package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import org.jspecify.annotations.Nullable;

public record FileEntry(String path, String name, String basename, String extension, FileKind kind, long size,
		Instant mtime, @Nullable String version, List<String> aliases) {
}
