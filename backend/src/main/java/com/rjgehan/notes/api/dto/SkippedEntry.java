package com.rjgehan.notes.api.dto;

/** A file on disk that is not indexed; {@code name} is its on-disk path, decoded leniently. */
public record SkippedEntry(String name, SkipReason reason) {
}
