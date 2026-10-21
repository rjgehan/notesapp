package com.rjgehan.notes.api.dto;

import java.util.List;

/** {@code corrections} lists the words typo tolerance replaced (API.md §12.1). */
public record SearchResponse(String query, int total, long tookMs, List<SearchHit> results,
		List<SearchCorrection> corrections) {
}
