package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum OnConflict {

	@JsonProperty("fail") FAIL,
	@JsonProperty("rename") RENAME

}
