package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

/** {@code titleRanges} are ranges in {@code basename}; {@code score} is 0 for filter-only queries. */
public record SearchHit(String path, String basename, double score, Instant mtime, List<TextRange> titleRanges,
		List<SearchMatch> matches, int moreMatches) {
}
