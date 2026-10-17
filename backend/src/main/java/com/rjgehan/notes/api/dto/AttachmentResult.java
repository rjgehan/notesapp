package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code markdown} is the full embed in the configured style; clients insert it as is. */
public record AttachmentResult(FileEntry file, boolean created, List<String> createdFolders, String linkText,
		String markdown) {
}
