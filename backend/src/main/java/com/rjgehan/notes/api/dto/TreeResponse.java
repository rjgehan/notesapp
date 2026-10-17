package com.rjgehan.notes.api.dto;

import java.util.List;

public record TreeResponse(String eventId, List<FolderEntry> folders, List<FileEntry> files) {
}
