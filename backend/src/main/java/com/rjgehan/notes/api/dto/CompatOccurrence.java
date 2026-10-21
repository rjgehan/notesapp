package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** Where a finding is: a file, a 0-based line when it is in a note's text, and the text found (clipped). */
public record CompatOccurrence(String path, @Nullable Integer line, String text) {
}
