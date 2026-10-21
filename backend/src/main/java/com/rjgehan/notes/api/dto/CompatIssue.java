package com.rjgehan.notes.api.dto;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.jspecify.annotations.Nullable;

/**
 * One kind of finding of the compatibility report: {@code count} occurrences in {@code noteCount} files, of which
 * {@code occurrences} lists at most 200 in path order ({@code truncated} when there are more).
 */
public record CompatIssue(String id, Category category, Severity severity, String title, String detail,
		@Nullable Integer roadmapItem, int count, int noteCount, List<CompatOccurrence> occurrences,
		boolean truncated) {

	public CompatIssue {
		occurrences = List.copyOf(occurrences);
	}

	public enum Category {

		@JsonProperty("syntax") SYNTAX,
		@JsonProperty("links") LINKS,
		@JsonProperty("files") FILES

	}

	/** {@code info}: works, differently; {@code warning}: shown wrong or not at all; {@code error}: data NotesApp cannot use. */
	public enum Severity {

		@JsonProperty("info") INFO,
		@JsonProperty("warning") WARNING,
		@JsonProperty("error") ERROR

	}

}
