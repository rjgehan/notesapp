package com.rjgehan.notes.api.dto;

import java.util.List;

public record WriteResult(FileEntry file, boolean created, List<String> createdFolders) {
}
