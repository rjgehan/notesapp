package com.rjgehan.notes.api.dto;

/** A half-open range {@code [from, to)} of UTF-16 offsets (API.md §1.4). */
public record TextRange(int from, int to) {
}
