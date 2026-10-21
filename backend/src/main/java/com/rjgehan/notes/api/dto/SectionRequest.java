package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** Creating or renaming a section. */
public record SectionRequest(@Nullable String name) {
}
