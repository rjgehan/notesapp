package com.rjgehan.notes.api;

import java.io.IOException;

import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.CommitResult;
import com.rjgehan.notes.api.dto.HistoryContent;
import com.rjgehan.notes.api.dto.HistoryResponse;
import com.rjgehan.notes.api.dto.HistoryRestoreRequest;
import com.rjgehan.notes.api.dto.HistoryRestoreResult;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.history.HistoryService;
import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

import org.springframework.core.io.Resource;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** History (API.md §14). */
@RestController
public class HistoryController {

	private static final int MAX_LIMIT = 200;

	private final HistoryService history;

	private final RawResponses raw;

	public HistoryController(HistoryService history, RawResponses raw) {
		this.history = history;
		this.raw = raw;
	}

	@GetMapping("/api/history")
	HistoryResponse list(@RequestParam String path, @RequestParam(defaultValue = "50") int limit,
			@RequestParam(defaultValue = "0") int offset) throws IOException {
		if (limit < 1 || limit > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		if (offset < 0) {
			throw NotesException.badRequest("offset must not be negative");
		}
		return this.history.list(path, limit, offset);
	}

	@GetMapping("/api/history/content")
	HistoryContent content(@RequestParam String path, @RequestParam String commit) throws IOException {
		return this.history.content(path, commit);
	}

	@GetMapping("/api/history/raw")
	ResponseEntity<Resource> raw(@RequestParam String path, @RequestParam String commit,
			@RequestParam(defaultValue = "false") boolean download) throws IOException {
		HistoryService.RawBlob blob = this.history.raw(path, commit);
		return this.raw.blob(blob.name(), blob.blobId(), blob.size(), () -> this.history.openBlob(blob.blobId()),
				download);
	}

	@PostMapping("/api/history/restore")
	HistoryRestoreResult restore(@Valid @RequestBody HistoryRestoreRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.history.restore(request, identity, origin);
	}

	@PostMapping("/api/history/commit")
	CommitResult commit() {
		GitStore.Commit commit = this.history.commitPending();
		return new CommitResult((commit != null) ? commit.id() : null);
	}

}
