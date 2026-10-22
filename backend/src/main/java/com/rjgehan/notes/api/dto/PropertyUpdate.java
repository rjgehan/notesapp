package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** A note whose property was (or, in a dry run, would be) renamed; {@code version} is null in a dry run. */
public record PropertyUpdate(String path, @Nullable String version) {
}
