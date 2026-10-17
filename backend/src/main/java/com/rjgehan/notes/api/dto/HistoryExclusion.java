package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Why a file's versions are not kept in git (API.md §14.1): today only {@code large-file}, a file over the
 * large-file threshold. {@code limitBytes} is that threshold.
 */
public record HistoryExclusion(Reason reason, long size, long limitBytes) {

	public enum Reason {

		@JsonProperty("large-file") LARGE_FILE

	}

}
