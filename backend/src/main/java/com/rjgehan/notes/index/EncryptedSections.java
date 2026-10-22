package com.rjgehan.notes.index;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Inline encrypted sections in notes (ROADMAP item 27, DESIGN §5.27): the Obsidian Meld Encrypt format
 * {@code %%🔐β 💡hint💡BASE64 🔐%%} (hidden in Obsidian's reading view) or {@code 🔐β 💡hint💡BASE64 🔐} (shown as a
 * marker), with the older {@code α} and unmarked prefixes. The server never decrypts them; it only keeps their
 * ciphertext out of search and out of what Ask your vault sends to Claude. The hint is plain text by design and stays
 * with the section.
 */
public final class EncryptedSections {

	/** The lock emoji every section starts and ends with. */
	static final String LOCK = "🔐";

	// Base64 payload (16 characters or more) with an optional 💡hint💡 before it, on one line. The commented form pairs
	// with its own suffix; the visible one needs its α or β mark, so words between two lock emoji are never a section.
	private static final String BODY = "(?:💡[^\\n]*?💡)?[A-Za-z0-9+/=]{16,}";

	private static final Pattern SECTION = Pattern
		.compile("%%" + LOCK + "[αβ]? " + BODY + " " + LOCK + "%%|" + LOCK + "[αβ] " + BODY + " " + LOCK);

	/** What Ask your vault sees instead of a section. */
	public static final String PLACEHOLDER = "[encrypted]";

	private EncryptedSections() {
	}

	/** True when the text may hold a section (a cheap check before any matching). */
	public static boolean mayContain(String text) {
		return text.contains(LOCK);
	}

	/**
	 * The text with every section replaced by spaces of the same UTF-16 length, so offsets, lines and the parse still
	 * line up while search finds nothing in the ciphertext. Returns the same instance when there is none.
	 */
	public static String blank(String text) {
		if (!mayContain(text)) {
			return text;
		}
		Matcher m = SECTION.matcher(text);
		StringBuilder out = null;
		while (m.find()) {
			if (out == null) {
				out = new StringBuilder(text);
			}
			for (int i = m.start(); i < m.end(); i++) {
				out.setCharAt(i, ' ');
			}
		}
		return (out != null) ? out.toString() : text;
	}

	/** The text with every section replaced by {@link #PLACEHOLDER}. Returns the same instance when there is none. */
	public static String strip(String text) {
		if (!mayContain(text)) {
			return text;
		}
		return SECTION.matcher(text).replaceAll(Matcher.quoteReplacement(PLACEHOLDER));
	}

}
