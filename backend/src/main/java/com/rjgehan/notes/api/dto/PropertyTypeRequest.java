package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** Sets (or, with a null {@code type}, removes) one property's type (API.md §38.2). */
public record PropertyTypeRequest(@Nullable String name, @Nullable String type) {
}
