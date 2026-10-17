package com.rjgehan.notes.api.dto;

/** An RFC 5545 {@code RRULE} value (without the {@code RRULE:} prefix) and what it counts from. */
public record TaskRecurrence(String rrule, RecurrenceFrom from) {
}
