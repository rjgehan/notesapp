package com.rjgehan.notes.api.error;

/** One invalid request field, for example {@code {"field":"path","message":"must not be null"}}. */
public record FieldError(String field, String message) {
}
