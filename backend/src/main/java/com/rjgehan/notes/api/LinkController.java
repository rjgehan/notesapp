package com.rjgehan.notes.api;

import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.ResolveRequest;
import com.rjgehan.notes.api.dto.ResolveResponse;
import com.rjgehan.notes.index.NoteService;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** {@code POST /api/links/resolve} (API.md §11.3): read-only, but a POST because of its body. */
@RestController
public class LinkController {

	private final NoteService notes;

	public LinkController(NoteService notes) {
		this.notes = notes;
	}

	@PostMapping("/api/links/resolve")
	ResolveResponse resolve(@Valid @RequestBody ResolveRequest request) {
		return this.notes.resolve(request.source(), request.targets());
	}

}
