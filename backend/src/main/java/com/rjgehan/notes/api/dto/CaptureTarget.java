package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Where a quick capture goes (API.md §8.5): {@code Inbox.md} at the vault root, or today's daily note. */
public enum CaptureTarget {

	@JsonProperty("inbox") INBOX,
	@JsonProperty("daily") DAILY

}
