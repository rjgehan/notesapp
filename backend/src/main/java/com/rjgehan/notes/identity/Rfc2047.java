package com.rjgehan.notes.identity;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

/**
 * Decodes RFC 2047 encoded words ({@code =?charset?Q?...?=} and {@code =?charset?B?...?=}). Tailscale sends non-ASCII
 * display names as one or more encoded words separated by spaces; whitespace between adjacent encoded words is
 * dropped. Anything that cannot be decoded is kept as written.
 */
public final class Rfc2047 {

	private static final Pattern ENCODED_WORD = Pattern.compile("=\\?([^?\\s]+)\\?([QqBb])\\?([^?\\s]*)\\?=");

	private Rfc2047() {
	}

	public static String decode(String value) {
		Matcher m = ENCODED_WORD.matcher(value);
		StringBuilder out = new StringBuilder(value.length());
		int last = 0;
		boolean previousWasEncoded = false;
		while (m.find()) {
			String between = value.substring(last, m.start());
			String decoded = decodeWord(m.group(1), m.group(2), m.group(3));
			if (decoded == null) {
				out.append(between).append(m.group());
				previousWasEncoded = false;
			}
			else {
				if (!(previousWasEncoded && between.isBlank())) {
					out.append(between);
				}
				out.append(decoded);
				previousWasEncoded = true;
			}
			last = m.end();
		}
		out.append(value.substring(last));
		return out.toString();
	}

	private static @Nullable String decodeWord(String charsetName, String encoding, String text) {
		Charset charset;
		try {
			int language = charsetName.indexOf('*');
			charset = Charset.forName((language >= 0) ? charsetName.substring(0, language) : charsetName);
		}
		catch (RuntimeException ex) {
			return null;
		}
		try {
			if (encoding.equalsIgnoreCase("B")) {
				return new String(Base64.getDecoder().decode(text), charset);
			}
			ByteArrayOutputStream bytes = new ByteArrayOutputStream();
			for (int i = 0; i < text.length(); i++) {
				char c = text.charAt(i);
				if (c == '_') {
					bytes.write(' ');
				}
				else if (c == '=' && i + 2 < text.length()) {
					bytes.write(Integer.parseInt(text, i + 1, i + 3, 16));
					i += 2;
				}
				else if (c == '=') {
					return null;
				}
				else {
					bytes.write(c);
				}
			}
			return bytes.toString(charset);
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}

}
