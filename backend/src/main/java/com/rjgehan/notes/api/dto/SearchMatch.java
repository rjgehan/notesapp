package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * A matching body line, clipped to 200 characters; {@code ranges} are relative to {@code text}. {@code page} is the
 * 1-based page of a PDF match, otherwise null.
 */
public record SearchMatch(int line, String text, List<TextRange> ranges, @Nullable Integer page) {
}
