package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.MirrorStatus;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.history.GitMirror;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** The git mirror (API.md §6.4): {@code POST /api/mirror/push}. Its status is part of {@code GET /api/status}. */
@RestController
public class MirrorController {

	private final GitMirror mirror;

	public MirrorController(GitMirror mirror) {
		this.mirror = mirror;
	}

	/** Pushes now, in the background; {@code status.changed} (reason {@code mirror}) follows when it is done. */
	@PostMapping("/api/mirror/push")
	ResponseEntity<MirrorStatus> push() {
		String reason = this.mirror.disabledReason();
		if (reason != null) {
			throw NotesException.badRequest("The mirror is off: " + reason);
		}
		return ResponseEntity.status(HttpStatus.ACCEPTED).body(this.mirror.requestPush());
	}

}
