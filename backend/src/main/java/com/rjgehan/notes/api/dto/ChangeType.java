package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum ChangeType {

	@JsonProperty("added") ADDED,
	@JsonProperty("modified") MODIFIED,
	@JsonProperty("renamed") RENAMED,
	@JsonProperty("deleted") DELETED

}
