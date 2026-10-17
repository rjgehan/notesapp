package com.rjgehan.notes.api.dto;

/** {@code count} notes with exactly this tag; {@code total} distinct notes with it or any descendant. */
public record TagCount(String tag, int count, int total) {
}
