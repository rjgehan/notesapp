package com.rjgehan.notes.api.dto;

import java.util.List;

/** The values a property has across the vault, most used first (API.md §38.3). */
public record PropertyValuesResponse(String name, List<PropertyValue> values) {
}
