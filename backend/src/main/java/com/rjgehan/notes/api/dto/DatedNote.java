package com.rjgehan.notes.api.dto;

/**
 * A note dated by a frontmatter property (API.md §25.1): {@code day} is the date part ({@code YYYY-MM-DD}) of
 * {@code value}, the property's value as written (a date, a date-time, or a link to a day).
 */
public record DatedNote(String path, String day, String property, String value) {
}
