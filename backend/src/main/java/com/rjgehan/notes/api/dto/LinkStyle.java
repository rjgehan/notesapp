package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum LinkStyle {

	@JsonProperty("wiki") WIKI,
	@JsonProperty("markdown") MARKDOWN

}
