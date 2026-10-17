package com.rjgehan.notes.api.dto;

import java.util.List;

public record TagsResponse(List<TagCount> tags) {
}
