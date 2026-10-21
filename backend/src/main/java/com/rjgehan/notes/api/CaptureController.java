package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.dto.CaptureRequest;
import com.rjgehan.notes.api.dto.CaptureResult;
import com.rjgehan.notes.api.dto.CaptureTarget;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.capture.CaptureService;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Quick capture (API.md §8.5, §8.6), for the app's capture box and share target and for an iOS Shortcut. Like every
 * mutation it needs {@code X-Client-Id} (and passes the Origin checks); a Shortcut sends a fixed id of its own.
 * {@code 201} when the capture created the note, {@code 200} when it appended to it.
 */
@RestController
public class CaptureController {

	private final CaptureService captures;

	private final IdempotencyCache idempotency;

	public CaptureController(CaptureService captures, IdempotencyCache idempotency) {
		this.captures = captures;
		this.idempotency = idempotency;
	}

	@PostMapping("/api/capture")
	ResponseEntity<CaptureResult> capture(@RequestBody CaptureRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> respond(this.captures.capture(request, identity, origin)));
	}

	@PostMapping("/api/capture/file")
	ResponseEntity<CaptureResult> captureFile(@RequestParam(required = false) @Nullable String name,
			@RequestParam(required = false) @Nullable String text,
			@RequestParam(required = false) @Nullable String target, @RequestParam(required = false) @Nullable String date,
			@RequestParam(required = false) @Nullable String time, @RequestParam(required = false) @Nullable String tz,
			InputStream body, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		if (name == null || name.isBlank()) {
			throw NotesException.badRequest("name is required");
		}
		CaptureTarget captureTarget = target(target);
		return this.idempotency.execute(idempotencyKey, http, () -> respond(this.captures.captureFile(name, text,
				captureTarget, date, time, tz, body, http.getContentLengthLong(), identity, origin)));
	}

	private static ResponseEntity<CaptureResult> respond(CaptureResult result) {
		return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result);
	}

	private static @Nullable CaptureTarget target(@Nullable String value) {
		if (value == null || value.isBlank()) {
			return null;
		}
		try {
			return CaptureTarget.valueOf(value.strip().toUpperCase(Locale.ROOT));
		}
		catch (IllegalArgumentException ex) {
			throw NotesException.badRequest("target must be inbox or daily");
		}
	}

}
