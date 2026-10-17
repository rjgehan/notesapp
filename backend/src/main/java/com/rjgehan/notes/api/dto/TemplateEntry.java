package com.rjgehan.notes.api.dto;

/** {@code name} is the basename without {@code .md}. */
public record TemplateEntry(String path, String name) {
}
