package com.rjgehan.notes.api.dto;

import java.util.List;

/** A matching body line, clipped to 200 characters; {@code ranges} are relative to {@code text}. */
public record SearchMatch(int line, String text, List<TextRange> ranges) {
}
