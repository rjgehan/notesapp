package com.rjgehan.notes.index;

import com.rjgehan.notes.api.dto.LinkStyle;
import org.jspecify.annotations.Nullable;

/**
 * One link or embed. {@code [from, to)} is the whole link; {@code [targetFrom, targetTo)} is the target as written
 * (for a markdown link, without angle brackets and without {@code #subpath}). {@code rewritable} is false for
 * frontmatter links whose source text does not map 1:1 to the parsed value; a move never splices those.
 * {@code quoting} says how the link's text is embedded, which decides how a rewrite must write its new target.
 */
public record LinkOcc(String raw, String target, @Nullable String subpath, @Nullable String display, boolean embed,
		LinkStyle style, boolean angle, int line, int from, int to, int targetFrom, int targetTo,
		boolean inFrontmatter, boolean rewritable, Quoting quoting) {

	/** Where a link's text lives: the note body, or a frontmatter YAML scalar of one of these styles. */
	public enum Quoting {

		/** Markdown text. */
		BODY,

		/** A plain (unquoted) YAML scalar. */
		PLAIN,

		/** A {@code '...'} YAML scalar, where {@code '} is written {@code ''}. */
		SINGLE_QUOTED,

		/** A {@code "..."} YAML scalar, where {@code \} and {@code "} are escaped with {@code \}. */
		DOUBLE_QUOTED,

		/** A literal ({@code |}) or folded ({@code >}) YAML block scalar. */
		BLOCK;

		/**
		 * {@code text} as it must be written inside such a link so that the parsed value reads {@code text}, or null
		 * when it cannot be written there without changing what the YAML means.
		 */
		public @Nullable String encode(String text) {
			if (this != BODY && hasControlCharacter(text)) {
				return null;
			}
			return switch (this) {
				case BODY, BLOCK -> text;
				case SINGLE_QUOTED -> text.replace("'", "''");
				case DOUBLE_QUOTED -> text.replace("\\", "\\\\").replace("\"", "\\\"");
				// ": " would start a mapping value and " #" a comment.
				case PLAIN -> (text.contains(": ") || text.contains(":\t") || text.contains(" #")
						|| text.contains("\t#")) ? null : text;
			};
		}

		private static boolean hasControlCharacter(String text) {
			for (int i = 0; i < text.length(); i++) {
				char c = text.charAt(i);
				if ((c < 0x20 && c != '\t') || c == 0x7f) {
					return true;
				}
			}
			return false;
		}

	}

}
