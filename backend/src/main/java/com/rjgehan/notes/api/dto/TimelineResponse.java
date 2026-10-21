package com.rjgehan.notes.api.dto;

import java.util.List;

public record TimelineResponse(List<TimelineEntry> entries, boolean hasMore) {
}
