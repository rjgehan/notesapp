package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** The FSRS state of a card (ts-fsrs {@code State}). */
public enum FlashcardPhase {

	@JsonProperty("new") NEW,
	@JsonProperty("learning") LEARNING,
	@JsonProperty("review") REVIEW,
	@JsonProperty("relearning") RELEARNING

}
