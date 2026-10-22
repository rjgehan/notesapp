package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/**
 * One frontmatter property of the vault (API.md §38.1): its name as most notes spell it, how many notes have it, its
 * type in the vault's type registry (null when it has none) and the type its values look like.
 */
public record PropertyInfo(String name, int count, @Nullable String type, String inferred) {
}
