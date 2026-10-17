package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Why a note's links could not be updated by a move. */
public enum FailedReason {

	@JsonProperty("not-utf8") NOT_UTF8,
	@JsonProperty("not-rewritable") NOT_REWRITABLE,
	@JsonProperty("span-mismatch") SPAN_MISMATCH,
	@JsonProperty("io-error") IO_ERROR

}
