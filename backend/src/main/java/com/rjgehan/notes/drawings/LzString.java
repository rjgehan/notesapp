package com.rjgehan.notes.drawings;

import java.util.ArrayList;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * Decompresses lz-string's base64 encoding ({@code LZString.decompressFromBase64} of lz-string 1.5.0, MIT), which
 * the Obsidian Excalidraw plugin uses for its {@code compressed-json} drawing blocks (ROADMAP item 5). A direct port
 * of lz-string's {@code _decompress}, written for this project; the tests compare it with lz-string's own output.
 * <p>
 * Like lz-string, characters outside the base64 alphabet read as zero bits, and input that runs out before the end
 * marker gives an empty string. Unlike it, input that would decompress to more than {@code maxLength} characters
 * gives null: a few kilobytes of crafted input can otherwise expand quadratically.
 */
public final class LzString {

	private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

	/** Each base64 character carries six bits, read from its highest: {@code resetValue} 32 in lz-string. */
	private static final int RESET = 32;

	private static final int[] VALUES = new int[128];

	/** Codes never get wider than this; a dictionary that large could not exist in memory anyway. */
	private static final int MAX_BITS = 30;

	static {
		for (int i = 0; i < ALPHABET.length(); i++) {
			VALUES[ALPHABET.charAt(i)] = i;
		}
	}

	private final String input;

	private int value;

	private int position = RESET;

	private int index = 1;

	private LzString(String input) {
		this.input = input;
		this.value = valueAt(0);
	}

	/**
	 * The text {@code input} encodes; whitespace (the plugin's line breaks between chunks) is ignored. Returns null for
	 * an empty or invalid input and when the text would be longer than {@code maxLength}, and "" when the input ends
	 * early, as lz-string does.
	 */
	public static @Nullable String decompressFromBase64(String input, int maxLength) {
		String compact = stripWhitespace(input);
		if (compact.isEmpty()) {
			return null;
		}
		return new LzString(compact).decompress(maxLength);
	}

	private static String stripWhitespace(String input) {
		StringBuilder out = new StringBuilder(input.length());
		for (int i = 0; i < input.length(); i++) {
			char c = input.charAt(i);
			if (!Character.isWhitespace(c)) {
				out.append(c);
			}
		}
		return out.toString();
	}

	private int valueAt(int i) {
		if (i >= this.input.length()) {
			return 0;
		}
		char c = this.input.charAt(i);
		return (c < VALUES.length) ? VALUES[c] : 0;
	}

	/** The next {@code count} bits, least significant first. */
	private int readBits(int count) {
		int bits = 0;
		for (int i = 0; i < count; i++) {
			int bit = this.value & this.position;
			this.position >>= 1;
			if (this.position == 0) {
				this.position = RESET;
				this.value = valueAt(this.index++);
			}
			if (bit != 0) {
				bits |= 1 << i;
			}
		}
		return bits;
	}

	private @Nullable String decompress(int maxLength) {
		// Codes 0, 1 and 2 mean "an 8-bit character follows", "a 16-bit character follows" and "end".
		List<@Nullable String> dictionary = new ArrayList<>();
		dictionary.add(null);
		dictionary.add(null);
		dictionary.add(null);
		int enlargeIn = 4;
		int numBits = 3;
		String first;
		switch (readBits(2)) {
			case 0 -> first = String.valueOf((char) readBits(8));
			case 1 -> first = String.valueOf((char) readBits(16));
			case 2 -> {
				return "";
			}
			default -> {
				return null;
			}
		}
		dictionary.add(first);
		String previous = first;
		StringBuilder result = new StringBuilder(first);
		while (true) {
			if (this.index > this.input.length()) {
				return "";
			}
			int code = readBits(numBits);
			if (code == 0 || code == 1) {
				dictionary.add(String.valueOf((char) readBits((code == 0) ? 8 : 16)));
				code = dictionary.size() - 1;
				enlargeIn--;
			}
			else if (code == 2) {
				return result.toString();
			}
			if (enlargeIn == 0) {
				if (numBits >= MAX_BITS) {
					return null;
				}
				enlargeIn = 1 << numBits;
				numBits++;
			}
			String entry;
			if (code < dictionary.size()) {
				entry = dictionary.get(code);
			}
			else if (code == dictionary.size()) {
				entry = previous + previous.charAt(0);
			}
			else {
				return null;
			}
			if (entry == null || result.length() + entry.length() > maxLength) {
				return null;
			}
			result.append(entry);
			dictionary.add(previous + entry.charAt(0));
			enlargeIn--;
			previous = entry;
			if (enlargeIn == 0) {
				if (numBits >= MAX_BITS) {
					return null;
				}
				enlargeIn = 1 << numBits;
				numBits++;
			}
		}
	}

}
