package com.rjgehan.notes.api.error;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import org.jspecify.annotations.Nullable;

/**
 * {@code 409 version-conflict} carrying the server's copy (API.md §4). All four conflict properties are always
 * present; they are null when the file no longer exists.
 */
public class VersionConflictException extends NotesException {

	public VersionConflictException(String path, @Nullable String currentVersion, @Nullable String currentContent,
			@Nullable Instant currentMtime, @Nullable String movedTo) {
		this(path, currentVersion, currentContent, currentMtime, movedTo,
				currentVersion != null ? "File changed on the server" : "File no longer exists on the server");
	}

	public VersionConflictException(String path, @Nullable String currentVersion, @Nullable String currentContent,
			@Nullable Instant currentMtime, @Nullable String movedTo, String detail) {
		super(ErrorCode.VERSION_CONFLICT, detail, properties(path, currentVersion, currentContent, currentMtime, movedTo));
	}

	private static Map<String, @Nullable Object> properties(String path, @Nullable String currentVersion,
			@Nullable String currentContent, @Nullable Instant currentMtime, @Nullable String movedTo) {
		Map<String, @Nullable Object> properties = new LinkedHashMap<>();
		properties.put("path", path);
		properties.put("currentVersion", currentVersion);
		properties.put("currentContent", currentContent);
		properties.put("currentMtime", currentMtime);
		properties.put("movedTo", movedTo);
		return properties;
	}

}
