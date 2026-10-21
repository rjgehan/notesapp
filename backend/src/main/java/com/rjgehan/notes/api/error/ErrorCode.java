package com.rjgehan.notes.api.error;

import java.net.URI;

import org.springframework.http.HttpStatus;

/**
 * The stable problem codes of API.md §3. Clients branch on {@link #code()}; titles are fixed per code.
 */
public enum ErrorCode {

	BAD_REQUEST("bad-request", HttpStatus.BAD_REQUEST, "Bad request"),
	INVALID_PATH("invalid-path", HttpStatus.BAD_REQUEST, "Invalid path"),
	INVALID_NAME("invalid-name", HttpStatus.BAD_REQUEST, "Invalid name"),
	MOVE_INTO_SELF("move-into-self", HttpStatus.BAD_REQUEST, "Cannot move a folder into itself"),
	CLIENT_ID_REQUIRED("client-id-required", HttpStatus.FORBIDDEN, "Client id required"),
	CROSS_ORIGIN("cross-origin", HttpStatus.FORBIDDEN, "Cross-origin request rejected"),
	IDENTITY_NOT_ALLOWED("identity-not-allowed", HttpStatus.FORBIDDEN, "Identity not allowed"),
	RESERVED_PATH("reserved-path", HttpStatus.FORBIDDEN, "Reserved path"),
	NOT_FOUND("not-found", HttpStatus.NOT_FOUND, "Not found"),
	METHOD_NOT_ALLOWED("method-not-allowed", HttpStatus.METHOD_NOT_ALLOWED, "Method not allowed"),
	ALREADY_EXISTS("already-exists", HttpStatus.CONFLICT, "Already exists"),
	CASE_COLLISION("case-collision", HttpStatus.CONFLICT, "Name differs only by case"),
	TYPE_MISMATCH("type-mismatch", HttpStatus.CONFLICT, "Wrong entry type"),
	VERSION_CONFLICT("version-conflict", HttpStatus.CONFLICT, "Version conflict"),
	SETTINGS_READ_ONLY("settings-read-only", HttpStatus.CONFLICT, "Settings are read-only"),
	TASK_CONFLICT("task-conflict", HttpStatus.CONFLICT, "Task changed on the server"),
	MALFORMED_FILE("malformed-file", HttpStatus.CONFLICT, "File cannot be read"),
	TOO_LARGE("too-large", HttpStatus.CONTENT_TOO_LARGE, "Too large"),
	NOT_TEXT("not-text", HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Not a text file"),
	UNSUPPORTED_MEDIA_TYPE("unsupported-media-type", HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Unsupported media type"),
	UNKNOWN_HOST("unknown-host", HttpStatus.MISDIRECTED_REQUEST, "Unknown host"),
	IO_ERROR("io-error", HttpStatus.INTERNAL_SERVER_ERROR, "Storage error"),
	PERMISSION_DENIED("permission-denied", HttpStatus.INTERNAL_SERVER_ERROR, "Permission denied"),
	INTERNAL_ERROR("internal-error", HttpStatus.INTERNAL_SERVER_ERROR, "Internal error"),
	BUSY("busy", HttpStatus.SERVICE_UNAVAILABLE, "Busy, retry"),
	HISTORY_UNAVAILABLE("history-unavailable", HttpStatus.SERVICE_UNAVAILABLE, "History unavailable"),
	INSUFFICIENT_STORAGE("insufficient-storage", HttpStatus.INSUFFICIENT_STORAGE, "Insufficient storage"),
	NOT_AUDIO("not-audio", HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Not an audio or video file"),
	TRANSCRIPTION_OFF("transcription-off", HttpStatus.CONFLICT, "Transcription is off"),
	TRANSCRIPTION_FAILED("transcription-failed", HttpStatus.SERVICE_UNAVAILABLE, "Transcription failed"),
	AI_UNAVAILABLE("ai-unavailable", HttpStatus.CONFLICT, "Ask and summaries are unavailable"),
	AI_EXCLUDED("ai-excluded", HttpStatus.FORBIDDEN, "Excluded from Ask and summaries"),
	AI_BUDGET_EXCEEDED("ai-budget-exceeded", HttpStatus.TOO_MANY_REQUESTS, "Monthly AI budget reached");

	private final String code;

	private final HttpStatus status;

	private final String title;

	ErrorCode(String code, HttpStatus status, String title) {
		this.code = code;
		this.status = status;
		this.title = title;
	}

	public String code() {
		return this.code;
	}

	public HttpStatus status() {
		return this.status;
	}

	public String title() {
		return this.title;
	}

	public URI type() {
		return URI.create("urn:notesapp:problem:" + this.code);
	}

}
