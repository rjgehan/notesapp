package com.rjgehan.notes.api.dto;

/**
 * {@code from}/{@code to} are absolute offsets in the source at {@code sourceVersion}; {@code contextRange} is
 * relative to {@code context}.
 */
public record Mention(int line, int from, int to, String matched, String context, TextRange contextRange) {
}
