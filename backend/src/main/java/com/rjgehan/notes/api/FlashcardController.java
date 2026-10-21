package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.FlashcardConfig;
import com.rjgehan.notes.api.dto.FlashcardConfigUpdateRequest;
import com.rjgehan.notes.api.dto.FlashcardNotesResponse;
import com.rjgehan.notes.api.dto.FlashcardPruneRequest;
import com.rjgehan.notes.api.dto.FlashcardReviewRequest;
import com.rjgehan.notes.api.dto.FlashcardUndoRequest;
import com.rjgehan.notes.api.dto.FlashcardWriteResult;
import com.rjgehan.notes.api.dto.FlashcardsResponse;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.flashcards.FlashcardService;
import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Flashcard review records, settings and source notes (API.md §34). */
@RestController
public class FlashcardController {

	private final FlashcardService flashcards;

	public FlashcardController(FlashcardService flashcards) {
		this.flashcards = flashcards;
	}

	@GetMapping("/api/flashcards")
	FlashcardsResponse state() throws IOException {
		return this.flashcards.state();
	}

	@GetMapping("/api/flashcards/notes")
	FlashcardNotesResponse notes() throws IOException {
		return this.flashcards.notes();
	}

	@PostMapping("/api/flashcards/reviews")
	FlashcardWriteResult review(@RequestBody FlashcardReviewRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.flashcards.review(request.reviews(), identity, origin);
	}

	@PostMapping("/api/flashcards/undo")
	FlashcardWriteResult undo(@RequestBody FlashcardUndoRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.flashcards.undo(request.card(), request.at(), request.state(), identity, origin);
	}

	@PostMapping("/api/flashcards/prune")
	FlashcardWriteResult prune(@RequestBody FlashcardPruneRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.flashcards.prune(request.cards(), identity, origin);
	}

	@PutMapping("/api/flashcards/config")
	FlashcardConfig config(@RequestBody FlashcardConfigUpdateRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.flashcards.updateConfig(request.config(), identity, origin);
	}

}
