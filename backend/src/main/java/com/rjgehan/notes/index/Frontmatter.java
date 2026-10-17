package com.rjgehan.notes.index;

import java.util.Map;

import org.jspecify.annotations.Nullable;

/**
 * A frontmatter block. {@code data} is the YAML 1.2 core-schema value as JSON-compatible maps, lists and scalars, or
 * null when the YAML is invalid (the block still counts as frontmatter). {@code [from, to)} spans both {@code ---}
 * lines, and {@code closingLine} is the line of the closing {@code ---}.
 */
public record Frontmatter(@Nullable Map<String, @Nullable Object> data, int from, int to, int closingLine) {
}
