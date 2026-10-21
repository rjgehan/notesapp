package com.rjgehan.notes.api.dto;

import java.time.Instant;

/**
 * A file deleted in history that does not exist now (API.md §14.8). Its last content is at
 * {@code parentCommitId}.
 */
public record DeletedFile(String path, Instant deletedAt, String commitId, String shortId, String parentCommitId,
		String authorName, String authorLogin, String message) {
}
