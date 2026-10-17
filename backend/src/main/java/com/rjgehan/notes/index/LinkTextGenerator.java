package com.rjgehan.notes.index;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.settings.LinkFormat;
import com.rjgehan.notes.vault.PathNames;

/**
 * Link text for the new-link formats (DESIGN §5.5.7, API.md §15.3). Client and server must produce identical output.
 * A round-trip guard falls back to the absolute form whenever the generated text would not resolve back to the
 * target.
 */
public final class LinkTextGenerator {

	private static final String MD_ENCODED = " ()<>[]#^|%";

	private static final char[] HEX = "0123456789ABCDEF".toCharArray();

	private LinkTextGenerator() {
	}

	/**
	 * The unencoded link text for wiki style, or the percent-encoded destination for markdown style.
	 */
	public static String linkText(String targetPath, String sourcePath, LinkFormat format, LinkStyle style,
			LinkResolver.Lookup lookup) {
		String text = plainText(targetPath, sourcePath, format, style, lookup);
		return (style == LinkStyle.MARKDOWN) ? encodeMdPath(text) : text;
	}

	/**
	 * The link text before markdown percent-encoding: what goes verbatim between angle brackets in
	 * {@code [text](<path.md>)}. For wiki style it equals {@link #linkText}.
	 */
	public static String plainText(String targetPath, String sourcePath, LinkFormat format, LinkStyle style,
			LinkResolver.Lookup lookup) {
		String name = (style == LinkStyle.WIKI) ? stripMd(targetPath) : targetPath;
		String text = switch (format) {
			case SHORTEST -> (lookup.filesByLowerName(PathNames.lower(PathNames.nameOf(targetPath))).size() == 1)
					? PathNames.nameOf(name) : name;
			case RELATIVE -> relative(PathNames.parentOf(sourcePath), name);
			case ABSOLUTE -> name;
		};
		if (!targetPath.equals(LinkResolver.resolve(text, sourcePath, lookup))) {
			text = name;
		}
		return text;
	}

	/**
	 * Percent-encodes, as UTF-8 bytes, exactly: space, {@code ( ) < > [ ] # ^ | %} and C0 controls. Everything else,
	 * including non-ASCII, is unchanged.
	 */
	public static String encodeMdPath(String s) {
		StringBuilder out = new StringBuilder(s.length() + 16);
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			if (c < 0x20 || MD_ENCODED.indexOf(c) >= 0) {
				out.append('%').append(HEX[(c >> 4) & 0xF]).append(HEX[c & 0xF]);
			}
			else {
				out.append(c);
			}
		}
		return out.toString();
	}

	/** A path relative to {@code fromFolder}, always starting with {@code ./} or {@code ../}. */
	static String relative(String fromFolder, String toPath) {
		String[] from = fromFolder.isEmpty() ? new String[0] : fromFolder.split("/");
		String[] to = toPath.split("/");
		int common = 0;
		while (common < from.length && common < to.length - 1 && from[common].equals(to[common])) {
			common++;
		}
		StringBuilder out = new StringBuilder();
		for (int i = common; i < from.length; i++) {
			out.append("../");
		}
		if (out.isEmpty()) {
			out.append("./");
		}
		for (int i = common; i < to.length; i++) {
			out.append(to[i]);
			if (i < to.length - 1) {
				out.append('/');
			}
		}
		return out.toString();
	}

	private static String stripMd(String path) {
		boolean md = path.length() >= 3 && path.regionMatches(true, path.length() - 3, ".md", 0, 3);
		return md ? path.substring(0, path.length() - 3) : path;
	}

}
