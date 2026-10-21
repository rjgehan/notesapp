package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

/**
 * {@code titleRanges} are ranges in {@code basename}; {@code score} is 0 for filter-only queries. {@code kind} is
 * {@code note}, or the kind of a file whose text is searched too (a PDF).
 */
public record SearchHit(String path, String basename, FileKind kind, double score, Instant mtime,
		List<TextRange> titleRanges, List<SearchMatch> matches, int moreMatches) {
}
