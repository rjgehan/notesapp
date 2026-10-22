package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Why a note could not be updated by a move, a heading rename or a property rename. */
public enum FailedReason {

	@JsonProperty("not-utf8") NOT_UTF8,
	@JsonProperty("not-rewritable") NOT_REWRITABLE,
	@JsonProperty("span-mismatch") SPAN_MISMATCH,
	@JsonProperty("io-error") IO_ERROR,
	/** A property rename (API.md §38.4): the note already has a property with the new name. */
	@JsonProperty("property-exists") PROPERTY_EXISTS

}
