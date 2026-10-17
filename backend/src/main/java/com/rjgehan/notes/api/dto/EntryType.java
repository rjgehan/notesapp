package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public enum EntryType {

	@JsonProperty("file") FILE,
	@JsonProperty("folder") FOLDER

}
