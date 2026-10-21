package com.rjgehan.notes.api;

import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.TranscribeRequest;
import com.rjgehan.notes.api.dto.TranscriptionResult;
import com.rjgehan.notes.api.dto.TranscriptionStatus;
import com.rjgehan.notes.transcribe.TranscriptionService;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Voice-note transcription (API.md §20, ROADMAP item 33): {@code GET /api/transcription} says whether it is on, and
 * {@code POST /api/transcriptions} returns the transcript of a recording in the vault. The client puts the text into
 * the note; nothing is written here.
 */
@RestController
public class TranscriptionController {

	private final TranscriptionService transcription;

	public TranscriptionController(TranscriptionService transcription) {
		this.transcription = transcription;
	}

	@GetMapping("/api/transcription")
	TranscriptionStatus status() {
		return this.transcription.status();
	}

	@PostMapping(path = "/api/transcriptions", consumes = MediaType.APPLICATION_JSON_VALUE)
	TranscriptionResult transcribe(@Valid @RequestBody TranscribeRequest request) {
		return this.transcription.transcribe(request.path());
	}

}
