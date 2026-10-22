package com.rjgehan.notes.api.dto;

import java.util.List;

/** Every frontmatter property of the vault, by name (API.md §38.1). */
public record PropertiesResponse(List<PropertyInfo> properties) {
}
