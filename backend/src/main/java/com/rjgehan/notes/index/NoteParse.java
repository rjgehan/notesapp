package com.rjgehan.notes.index;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.TextRange;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Everything {@link MarkdownScanner} extracts from a note. All offsets are UTF-16 indexes into the BOM-stripped text,
 * which is exactly {@code TextFile.content}; {@code lineStarts[i]} is the offset of line {@code i}. {@code linkSpans}
 * covers every link in the body, wiki or markdown, internal or external, including a markdown link's text: only
 * internal ones become {@link LinkOcc}s, but no link may be mistaken for plain text (DESIGN §5.5.9).
 */
public record NoteParse(@Nullable Frontmatter frontmatter, @Nullable String frontmatterError, List<String> aliases,
		List<TagOcc> tags, List<HeadingOcc> headings, List<LinkOcc> links, List<String> blockIds, int[] lineStarts,
		List<TextRange> excluded, List<TextRange> linkSpans, boolean hadBom, boolean lossy) {

	/** The distinct tags in the casing first seen, in order of first appearance. */
	public List<String> distinctTags() {
		Map<String, String> seen = new LinkedHashMap<>();
		for (TagOcc tag : this.tags) {
			seen.putIfAbsent(PathNames.lower(tag.tag()), tag.tag());
		}
		return List.copyOf(seen.values());
	}

}
