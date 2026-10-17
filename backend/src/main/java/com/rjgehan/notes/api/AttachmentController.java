package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.InputStream;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.dto.AttachmentResult;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.AttachmentService;
import org.jspecify.annotations.Nullable;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** {@code POST /api/attachments} (API.md §9.3): the body is the raw bytes. */
@RestController
public class AttachmentController {

	private final AttachmentService attachments;

	private final IdempotencyCache idempotency;

	public AttachmentController(AttachmentService attachments, IdempotencyCache idempotency) {
		this.attachments = attachments;
		this.idempotency = idempotency;
	}

	@PostMapping("/api/attachments")
	ResponseEntity<AttachmentResult> upload(@RequestParam(required = false) @Nullable String name,
			@RequestParam(required = false) @Nullable String source, InputStream body, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		if (name == null || name.isBlank()) {
			throw NotesException.badRequest("name is required");
		}
		return this.idempotency.execute(idempotencyKey, http, () -> ResponseEntity.status(HttpStatus.CREATED)
			.body(this.attachments.upload(name, source, body, http.getContentLengthLong(), identity, origin)));
	}

}
