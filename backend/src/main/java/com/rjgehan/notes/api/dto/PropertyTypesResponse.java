package com.rjgehan.notes.api.dto;

import java.util.Map;

import org.jspecify.annotations.Nullable;

/**
 * The vault's property types (API.md §38.2): property name to type. {@code version} is the blob id of
 * {@code .notesapp/types.json} (null while it does not exist); {@code source} says where the types were read from:
 * {@code notesapp}, {@code obsidian} ({@code .obsidian/types.json}, until the first change) or null (none yet).
 */
public record PropertyTypesResponse(Map<String, String> types, @Nullable String version, @Nullable String source) {
}
