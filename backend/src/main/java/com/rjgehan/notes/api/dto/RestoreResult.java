package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

public record RestoreResult(EntryType type, String path, List<FileEntry> files, List<String> createdFolders,
		@Nullable String commitId) {
}
