package com.rjgehan.notes.index;

/** A note within its size limit: its text and parse, kept in memory for backlinks, mentions and search. */
public record NoteRecord(String path, String version, String text, NoteParse parse, int docId) {

	/**
	 * The text search reads: {@link #text} with inline encrypted sections blanked to spaces of the same length (ROADMAP
	 * item 27), so their ciphertext never matches while offsets and lines stay those of the text.
	 */
	public String searchText() {
		return EncryptedSections.blank(this.text);
	}

}
