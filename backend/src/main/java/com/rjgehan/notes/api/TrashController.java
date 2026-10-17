package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.PurgeResult;
import com.rjgehan.notes.api.dto.RestoreRequest;
import com.rjgehan.notes.api.dto.RestoreResult;
import com.rjgehan.notes.api.dto.TrashListResponse;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.TrashService;
import org.jspecify.annotations.Nullable;

import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** The trash (API.md §13). */
@RestController
public class TrashController {

	private final TrashService trash;

	private final RawResponses raw;

	public TrashController(TrashService trash, RawResponses raw) {
		this.trash = trash;
		this.raw = raw;
	}

	@GetMapping("/api/trash")
	TrashListResponse list() throws IOException {
		return new TrashListResponse(this.trash.list());
	}

	@GetMapping("/api/trash/{id}/raw")
	ResponseEntity<Resource> raw(@PathVariable String id, @RequestParam(defaultValue = "false") boolean download)
			throws IOException {
		return this.raw.file(this.trash.openRaw(id), null, download);
	}

	/** The body may be empty, {@code {}}, or a {@link RestoreRequest}. */
	@PostMapping("/api/trash/{id}/restore")
	RestoreResult restore(@PathVariable String id, @RequestBody(required = false) @Nullable RestoreRequest request,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.trash.restore(id, request, identity, origin);
	}

	@DeleteMapping("/api/trash/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void purge(@PathVariable String id) throws IOException {
		this.trash.purge(id);
	}

	@DeleteMapping("/api/trash")
	PurgeResult empty() throws IOException {
		return new PurgeResult(this.trash.empty());
	}

}
