package com.rjgehan.notes.index;

import org.jspecify.annotations.Nullable;

/**
 * Feeds search, backlinks and tags from a text kind other than notes (DESIGN §6.8, "Backend counterpart"), without
 * touching {@link MarkdownScanner}. An implementation turns a document into its searchable text and the links and
 * tags in it; the index then holds the document like a note whose text is that searchable text: it is found by search,
 * its links count as backlinks of their targets, and its tags are counted. Moves never rewrite its links: their
 * offsets point into the searchable text, not into the file, and {@code MoveService} rewrites notes only.
 */
public interface DocumentIndexer {

	/** True for the paths this indexer reads (by extension). */
	boolean supports(String path);

	/**
	 * The document's searchable text with its links and tags, or null when the text is not a valid document (the file
	 * is then listed by name only).
	 */
	@Nullable Indexed index(String path, String text);

	/**
	 * {@code searchText} is what search snippets and backlink contexts show; every offset and line in {@code parse}
	 * refers to it. Its links are not rewritable and it has no frontmatter or aliases.
	 */
	record Indexed(String searchText, NoteParse parse) {
	}

}
