package com.rjgehan.notes.api.dto;

import java.util.List;

public record FolderResult(FolderEntry folder, List<String> createdFolders) {
}
