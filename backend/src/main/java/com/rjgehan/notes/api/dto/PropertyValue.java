package com.rjgehan.notes.api.dto;

/** A value of a property and the number of notes that have it (API.md §38.3). */
public record PropertyValue(String value, int count) {
}
