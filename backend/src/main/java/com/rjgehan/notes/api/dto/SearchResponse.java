package com.rjgehan.notes.api.dto;

import java.util.List;

public record SearchResponse(String query, int total, long tookMs, List<SearchHit> results) {
}
