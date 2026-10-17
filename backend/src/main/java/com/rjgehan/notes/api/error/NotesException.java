package com.rjgehan.notes.api.error;

import java.util.List;
import java.util.Map;

import org.jspecify.annotations.Nullable;

import org.springframework.http.ProblemDetail;
import org.springframework.web.ErrorResponseException;

/**
 * A domain error that renders as an RFC 9457 problem with a stable {@code code} (API.md §3). Extra properties are
 * serialized even when their value is null, because the contract declares them as {@code T | null}.
 */
public class NotesException extends ErrorResponseException {

	private final ErrorCode code;

	public NotesException(ErrorCode code, String detail) {
		this(code, detail, Map.of(), null);
	}

	public NotesException(ErrorCode code, String detail, Map<String, ? extends @Nullable Object> extra) {
		this(code, detail, extra, null);
	}

	public NotesException(ErrorCode code, String detail, Map<String, ? extends @Nullable Object> extra,
			@Nullable Throwable cause) {
		super(code.status(), problem(code, detail, extra), cause);
		this.code = code;
		if (code == ErrorCode.BUSY) {
			getHeaders().set("Retry-After", "1");
		}
	}

	public ErrorCode code() {
		return this.code;
	}

	@Override
	public String getMessage() {
		String detail = getBody().getDetail();
		return this.code.code() + ": " + (detail != null ? detail : this.code.title());
	}

	static ProblemDetail problem(ErrorCode code, @Nullable String detail, Map<String, ? extends @Nullable Object> extra) {
		ProblemDetail problem = ProblemDetail.forStatus(code.status());
		problem.setType(code.type());
		problem.setTitle(code.title());
		problem.setDetail(detail);
		problem.setProperty("code", code.code());
		extra.forEach(problem::setProperty);
		return problem;
	}

	public static NotesException badRequest(String detail) {
		return new NotesException(ErrorCode.BAD_REQUEST, detail, Map.of("errors", List.of()));
	}

	public static NotesException invalidPath(String path, String detail) {
		return new NotesException(ErrorCode.INVALID_PATH, detail, Map.of("path", path));
	}

	public static NotesException invalidName(String path, String detail) {
		return new NotesException(ErrorCode.INVALID_NAME, detail, Map.of("path", path));
	}

	public static NotesException reservedPath(String path) {
		return new NotesException(ErrorCode.RESERVED_PATH, "Hidden and internal paths cannot be accessed",
				Map.of("path", path));
	}

	public static NotesException notFound(String path) {
		return new NotesException(ErrorCode.NOT_FOUND, "No such file or folder: " + path, Map.of("path", path));
	}

	public static NotesException alreadyExists(String path, String existingPath) {
		return new NotesException(ErrorCode.ALREADY_EXISTS, "An entry already exists at " + existingPath,
				Map.of("path", path, "existingPath", existingPath));
	}

	public static NotesException caseCollision(String path, String existingPath) {
		return new NotesException(ErrorCode.CASE_COLLISION,
				"An entry whose name differs only by case already exists: " + existingPath,
				Map.of("path", path, "existingPath", existingPath));
	}

	public static NotesException moveIntoSelf(String from, String to) {
		return new NotesException(ErrorCode.MOVE_INTO_SELF, "A folder cannot be moved into itself or a descendant",
				Map.of("from", from, "to", to));
	}

	/** {@code expected} is {@code "file"}, {@code "folder"} or {@code "note"}. */
	public static NotesException typeMismatch(String path, String expected, String detail) {
		return new NotesException(ErrorCode.TYPE_MISMATCH, detail, Map.of("path", path, "expected", expected));
	}

	public static NotesException tooLarge(long limit, String detail) {
		return new NotesException(ErrorCode.TOO_LARGE, detail, Map.of("limit", limit));
	}

	public static NotesException notText(String path, String kind) {
		return new NotesException(ErrorCode.NOT_TEXT, "Not a text file: " + path, Map.of("path", path, "kind", kind));
	}

	public static NotesException busy() {
		return new NotesException(ErrorCode.BUSY, "The vault is busy; retry shortly");
	}

	/**
	 * {@code reason} is {@code "disabled"}, {@code "unusable: <detail>"}, {@code "importing"} or
	 * {@code "commit-failed"}.
	 */
	public static NotesException historyUnavailable(String reason, String detail) {
		return new NotesException(ErrorCode.HISTORY_UNAVAILABLE, detail, Map.of("reason", reason));
	}

	public static NotesException insufficientStorage(long minFree) {
		return new NotesException(ErrorCode.INSUFFICIENT_STORAGE,
				"The upload would leave less free space than the server requires", Map.of("limit", minFree));
	}

}
