package com.rjgehan.notes.index;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Search tokens (DESIGN §5.5.10): maximal runs of letters and numbers, except that each Han, Hiragana or Katakana
 * code point is a token of its own. Terms are NFKC-normalized, lower-cased and stripped of diacritics, so matching is
 * case-, accent- and width-insensitive; every token keeps the UTF-16 range of its original text, so highlights point
 * at what the user wrote. There are no stop words and no stemming.
 */
public final class Tokenizer {

	private Tokenizer() {
	}

	/** A normalized term and its {@code [from, to)} range in the original text. */
	public record Token(String term, int from, int to) {
	}

	public static List<Token> tokenize(String text) {
		return tokenize(text, 0, text.length());
	}

	/** The tokens of {@code text} between {@code from} and {@code to}; offsets stay relative to {@code text}. */
	public static List<Token> tokenize(String text, int from, int to) {
		List<Token> tokens = new ArrayList<>();
		int i = from;
		while (i < to) {
			int cp = text.codePointAt(i);
			int next = i + Character.charCount(cp);
			if (isIdeograph(cp)) {
				tokens.add(new Token(normalize(text.substring(i, next)), i, next));
				i = next;
			}
			else if (isWordChar(cp)) {
				int start = i;
				i = next;
				while (i < to) {
					int c = text.codePointAt(i);
					if (isIdeograph(c) || !(isWordChar(c) || isMark(c))) {
						break;
					}
					i += Character.charCount(c);
				}
				tokens.add(new Token(normalize(text.substring(start, i)), start, i));
			}
			else {
				i = next;
			}
		}
		return tokens;
	}

	/** NFKC, lower case, then diacritics removed (NFD without combining marks). */
	public static String normalize(String raw) {
		if (isAscii(raw)) {
			return raw.toLowerCase(Locale.ROOT);
		}
		String folded = Normalizer.normalize(raw, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
		String decomposed = Normalizer.normalize(folded, Normalizer.Form.NFD);
		StringBuilder out = new StringBuilder(decomposed.length());
		for (int i = 0; i < decomposed.length();) {
			int cp = decomposed.codePointAt(i);
			if (!isMark(cp)) {
				out.appendCodePoint(cp);
			}
			i += Character.charCount(cp);
		}
		return Normalizer.normalize(out, Normalizer.Form.NFC);
	}

	private static boolean isWordChar(int cp) {
		if (Character.isLetter(cp)) {
			return true;
		}
		int type = Character.getType(cp);
		return type == Character.DECIMAL_DIGIT_NUMBER || type == Character.LETTER_NUMBER
				|| type == Character.OTHER_NUMBER;
	}

	private static boolean isMark(int cp) {
		int type = Character.getType(cp);
		return type == Character.NON_SPACING_MARK || type == Character.COMBINING_SPACING_MARK
				|| type == Character.ENCLOSING_MARK;
	}

	private static boolean isIdeograph(int cp) {
		if (cp < 0x2E80) {
			return false;
		}
		Character.UnicodeScript script = Character.UnicodeScript.of(cp);
		return script == Character.UnicodeScript.HAN || script == Character.UnicodeScript.HIRAGANA
				|| script == Character.UnicodeScript.KATAKANA;
	}

	private static boolean isAscii(String s) {
		for (int i = 0; i < s.length(); i++) {
			if (s.charAt(i) >= 0x80) {
				return false;
			}
		}
		return true;
	}

}
