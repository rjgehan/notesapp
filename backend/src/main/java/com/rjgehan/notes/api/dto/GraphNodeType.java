package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code GraphNode.type} (API.md §11.4): a note, any other file, or the target of links that resolve to nothing. */
public enum GraphNodeType {

	@JsonProperty("note") NOTE,
	@JsonProperty("attachment") ATTACHMENT,
	@JsonProperty("unresolved") UNRESOLVED

}
