package com.rjgehan.notes.api.dto;

import java.util.List;
import java.util.Map;

import org.jspecify.annotations.Nullable;

/** Parsed metadata of a note; {@code frontmatter} is null when there is none or it is invalid. */
public record NoteMeta(String path, String version, @Nullable Map<String, @Nullable Object> frontmatter,
		@Nullable String frontmatterError, List<String> aliases, List<String> tags, List<HeadingInfo> headings,
		List<String> blockIds, List<OutgoingLink> links) {
}
