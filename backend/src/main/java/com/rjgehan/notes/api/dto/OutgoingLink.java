package com.rjgehan.notes.api.dto;

import org.jspecify.annotations.Nullable;

/** {@code target} is decoded and trimmed; {@code resolved} is the file it resolves to, or null. */
public record OutgoingLink(String raw, String target, @Nullable String subpath, @Nullable String display,
		boolean embed, LinkStyle style, int line, int from, int to, boolean inFrontmatter, @Nullable String resolved) {
}
