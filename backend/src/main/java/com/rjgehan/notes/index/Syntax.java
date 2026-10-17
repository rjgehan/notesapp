package com.rjgehan.notes.index;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

/**
 * The inline syntax rules shared with the client parsers (API.md §15.6): tags, wikilink bodies and markdown link
 * destinations. Whitespace follows JavaScript's {@code \s} so both sides agree on non-ASCII spaces.
 */
public final class Syntax {

	/** JavaScript's {@code \s}, as a character-class body. */
	static final String WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";

	private static final String TAG_CHAR = "[^" + WS + "\\x21-\\x2C\\x2E\\x3A-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7E]";

	/** {@code #tag} at the start or after whitespace; group 1 is the tag without {@code #}. */
	public static final Pattern TAG = Pattern.compile("(?<![^" + WS + "])#(" + TAG_CHAR + "+)");

	private static final Pattern TAG_BODY = Pattern.compile(TAG_CHAR + "+");

	/** Wikilink or embed; group 1 is {@code !} or empty, group 2 the body. */
	public static final Pattern WIKILINK = Pattern.compile("(!?)\\[\\[([^\\[\\]\\n]*?)\\]\\]");

	/** Markdown link or image; group 1 {@code !}, group 2 the text, group 3 the destination (maybe in angle brackets). */
	public static final Pattern MARKDOWN_LINK = Pattern
		.compile("(!?)\\[([^\\]\\n]*)\\]\\(\\s*(<[^>\\n]*>|[^\\s)]+)(?:\\s+\"[^\"\\n]*\")?\\s*\\)");

	private static final Pattern URI_SCHEME = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]*:");

	private static final Pattern ALL_DIGITS = Pattern.compile("[0-9]+");

	private Syntax() {
	}

	/** True for JavaScript whitespace. */
	public static boolean isWhitespace(char c) {
		return c == '\t' || c == '\n' || c == 0x0B || c == '\f' || c == '\r' || c == ' ' || c == 0xA0 || c == 0x1680
				|| (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F
				|| c == 0x3000 || c == 0xFEFF;
	}

	/** {@code String.prototype.trim()}. */
	public static String trim(String s) {
		int start = 0;
		int end = s.length();
		while (start < end && isWhitespace(s.charAt(start))) {
			start++;
		}
		while (end > start && isWhitespace(s.charAt(end - 1))) {
			end--;
		}
		return s.substring(start, end);
	}

	/**
	 * Normalizes a tag found by {@link #TAG} or listed in frontmatter: drops a trailing {@code /}, and returns null when
	 * what remains is not a tag (empty, all digits, or containing a forbidden character).
	 */
	public static @Nullable String normalizeTag(String raw) {
		String tag = raw;
		while (tag.endsWith("/")) {
			tag = tag.substring(0, tag.length() - 1);
		}
		if (tag.isEmpty() || !TAG_BODY.matcher(tag).matches() || ALL_DIGITS.matcher(tag).matches()) {
			return null;
		}
		return tag;
	}

	/** The parts of a wikilink body (API.md §15.6) and where the trimmed target sits inside the body. */
	public record WikiBody(String target, @Nullable String subpath, @Nullable String display, int targetStart,
			int targetEnd) {
	}

	public static WikiBody parseWikiBody(String body) {
		String left = body;
		String display = null;
		int pipe = body.indexOf('|');
		if (pipe >= 0) {
			display = body.substring(pipe + 1);
			left = body.substring(0, (pipe > 0 && body.charAt(pipe - 1) == '\\') ? pipe - 1 : pipe);
		}
		String targetPart = left;
		String subpath = null;
		int hash = left.indexOf('#');
		if (hash >= 0) {
			targetPart = left.substring(0, hash);
			subpath = left.substring(hash + 1);
		}
		int start = 0;
		int end = targetPart.length();
		while (start < end && isWhitespace(targetPart.charAt(start))) {
			start++;
		}
		while (end > start && isWhitespace(targetPart.charAt(end - 1))) {
			end--;
		}
		return new WikiBody(targetPart.substring(start, end), subpath, display, start, end);
	}

	/** True when a markdown destination points inside the vault: no URI scheme and not protocol-relative. */
	public static boolean isInternalDestination(String destination) {
		return !URI_SCHEME.matcher(destination).find() && !destination.startsWith("//");
	}

	/**
	 * Percent-decodes UTF-8 sequences, leaving {@code +} alone (unlike {@code URLDecoder}). A run of escapes that is
	 * not valid UTF-8 is kept as written.
	 */
	public static String percentDecode(String s) {
		if (s.indexOf('%') < 0) {
			return s;
		}
		StringBuilder out = new StringBuilder(s.length());
		int i = 0;
		while (i < s.length()) {
			if (isEscape(s, i)) {
				ByteArrayOutputStream bytes = new ByteArrayOutputStream();
				int j = i;
				while (isEscape(s, j)) {
					bytes.write(Integer.parseInt(s, j + 1, j + 3, 16));
					j += 3;
				}
				out.append(decodeUtf8OrRaw(bytes.toByteArray(), s.substring(i, j)));
				i = j;
			}
			else {
				out.append(s.charAt(i));
				i++;
			}
		}
		return out.toString();
	}

	private static String decodeUtf8OrRaw(byte[] bytes, String raw) {
		try {
			return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
		}
		catch (CharacterCodingException ex) {
			return raw;
		}
	}

	private static boolean isEscape(String s, int i) {
		return i + 2 < s.length() && s.charAt(i) == '%' && Character.digit(s.charAt(i + 1), 16) >= 0
				&& Character.digit(s.charAt(i + 2), 16) >= 0;
	}

}
