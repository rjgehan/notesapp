package com.rjgehan.notes.vault;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The new-name rules and the attachment-name sanitizer of DESIGN §4.4, the ignored-name patterns of §4.5, and unique
 * name generation ({@code " 1"} to {@code " 999"}).
 */
@Component
public class NameRules {

	/** A new segment is capped below the 255-byte limit so a de-duplication suffix up to " 999" still fits. */
	public static final int MAX_NEW_SEGMENT_BYTES = 240;

	public static final int MAX_SUFFIX = 999;

	private static final Pattern WINDOWS_RESERVED = Pattern.compile("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?");

	private static final String WINDOWS_FORBIDDEN = ":*?\"<>|";

	private static final String LINK_FORBIDDEN = "#^[]|";

	private static final String SANITIZED = ":*?\"<>|#^[]";

	private final FileKinds fileKinds;

	public NameRules(FileKinds fileKinds) {
		this.fileKinds = fileKinds;
	}

	/**
	 * Returns why {@code segment} breaks the new-name rules, or null when it is a valid new name. The safety rules are
	 * checked separately by {@link VaultPaths}.
	 */
	public static @Nullable String newNameViolation(String segment) {
		String windows = windowsViolation(segment);
		if (windows != null) {
			return windows;
		}
		for (int i = 0; i < segment.length(); i++) {
			if (LINK_FORBIDDEN.indexOf(segment.charAt(i)) >= 0) {
				return "Names cannot contain # ^ [ ] | or %%";
			}
		}
		if (segment.contains("%%")) {
			return "Names cannot contain # ^ [ ] | or %%";
		}
		if (!segment.isEmpty() && (isWhitespace(segment.charAt(0)) || isWhitespace(segment.charAt(segment.length() - 1)))) {
			return "Names cannot start or end with whitespace";
		}
		if (segment.getBytes(StandardCharsets.UTF_8).length > MAX_NEW_SEGMENT_BYTES) {
			return "Names are limited to " + MAX_NEW_SEGMENT_BYTES + " bytes";
		}
		if (isIgnored(segment)) {
			return "The server ignores names like this one";
		}
		return null;
	}

	/**
	 * The rules Windows enforces on every name: the characters {@code : * ? " < > |}, a trailing dot or space, and
	 * reserved device names. On a Windows host they also apply to existing names.
	 */
	public static @Nullable String windowsViolation(String segment) {
		for (int i = 0; i < segment.length(); i++) {
			if (WINDOWS_FORBIDDEN.indexOf(segment.charAt(i)) >= 0) {
				return "Names cannot contain : * ? \" < > |";
			}
		}
		if (segment.endsWith(".") || segment.endsWith(" ")) {
			return "Names cannot end with a dot or a space";
		}
		if (WINDOWS_RESERVED.matcher(segment).matches()) {
			return "Names cannot be a reserved device name such as con or lpt1";
		}
		return null;
	}

	/**
	 * True when every segment of {@code path} passes both the safety rules and the new-name rules, without consulting
	 * the disk. Used for paths computed by the server, such as link create paths.
	 */
	public static boolean isValidNewPath(String path) {
		if (path.isEmpty() || path.length() > VaultPaths.MAX_PATH_CHARS) {
			return false;
		}
		for (String segment : path.split("/", -1)) {
			if (segment.isEmpty() || segment.startsWith(".")) {
				return false;
			}
			for (int i = 0; i < segment.length(); i++) {
				char c = segment.charAt(i);
				if (c == '\\' || c < 0x20 || c == 0x7f) {
					return false;
				}
			}
			if (newNameViolation(segment) != null) {
				return false;
			}
		}
		return true;
	}

	/** True for names the watcher, index and tree ignore (DESIGN §4.5), dot-files included. */
	public static boolean isIgnored(String name) {
		if (name.startsWith(".")) {
			return true;
		}
		String lower = name.toLowerCase(Locale.ROOT);
		return lower.endsWith(".swp") || lower.endsWith(".swx") || lower.endsWith("~") || lower.equals("4913")
				|| lower.equals("thumbs.db") || lower.endsWith(".tmp") || lower.endsWith(".crdownload")
				|| lower.endsWith(".part");
	}

	/** {@code "Untitled.md", 1 → "Untitled 1.md"}; the final extension is kept. */
	public static String withSuffix(String name, int n) {
		String ext = PathNames.extensionOf(name);
		if (ext.isEmpty()) {
			return name + " " + n;
		}
		String base = PathNames.basenameOf(name);
		return base + " " + n + name.substring(base.length());
	}

	/**
	 * Turns any client-supplied file name into a valid new name instead of rejecting it (API.md §9.3).
	 */
	public String sanitizeAttachmentName(String raw) {
		// 1. Only the part after the last separator.
		String name = raw.substring(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
		// 2. NFC.
		name = Normalizer.normalize(name, Normalizer.Form.NFC);
		// 3. Control characters and forbidden characters become '-'.
		StringBuilder replaced = new StringBuilder(name.length());
		for (int i = 0; i < name.length(); i++) {
			char c = name.charAt(i);
			if (c < 0x20 || c == 0x7f || SANITIZED.indexOf(c) >= 0) {
				replaced.append('-');
			}
			else if (c == '%' && i + 1 < name.length() && name.charAt(i + 1) == '%') {
				replaced.append('-');
				i++;
			}
			else {
				replaced.append(c);
			}
		}
		name = replaced.toString();
		// 4. Collapse whitespace; split the extension off so leading and trailing dots and spaces are stripped from the
		// right parts. A dot-only prefix (".png") leaves an empty basename only when the extension is a known one.
		name = name.replaceAll("\\s+", " ");
		String base = name;
		String ext = "";
		int dot = name.lastIndexOf('.');
		if (dot >= 0 && dot < name.length() - 1) {
			String candidateBase = stripLeadingDotsAndSpaces(name.substring(0, dot));
			String candidateExt = name.substring(dot + 1);
			if (!candidateBase.isEmpty() || this.fileKinds.isKnownExtension(candidateExt)) {
				base = name.substring(0, dot);
				ext = candidateExt.strip();
			}
		}
		base = stripLeadingDotsAndSpaces(base);
		if (ext.isEmpty()) {
			base = stripTrailingDotsAndSpaces(base);
		}
		// 8 (checked early so that reserved and ignored names below see the final basename).
		if (base.isEmpty()) {
			base = "attachment";
		}
		String result = ext.isEmpty() ? base : base + "." + ext;
		// 5. Windows reserved basename.
		if (WINDOWS_RESERVED.matcher(result).matches()) {
			result = "_" + result;
		}
		// 6. Ignored patterns.
		if (isIgnored(result)) {
			result = result + ".file";
		}
		// 7. Fit 240 bytes, truncating the basename on a code-point boundary.
		return truncate(result);
	}

	private static String truncate(String name) {
		if (name.getBytes(StandardCharsets.UTF_8).length <= MAX_NEW_SEGMENT_BYTES) {
			return name;
		}
		String ext = PathNames.extensionOf(name);
		String suffix = ext.isEmpty() ? "" : name.substring(PathNames.basenameOf(name).length());
		int budget = MAX_NEW_SEGMENT_BYTES - suffix.getBytes(StandardCharsets.UTF_8).length;
		if (budget <= 0) {
			suffix = "";
			budget = MAX_NEW_SEGMENT_BYTES;
		}
		String base = suffix.isEmpty() ? name : PathNames.basenameOf(name);
		StringBuilder kept = new StringBuilder();
		int bytes = 0;
		for (int i = 0; i < base.length();) {
			int cp = base.codePointAt(i);
			int cpBytes = new String(Character.toChars(cp)).getBytes(StandardCharsets.UTF_8).length;
			if (bytes + cpBytes > budget) {
				break;
			}
			kept.appendCodePoint(cp);
			bytes += cpBytes;
			i += Character.charCount(cp);
		}
		String truncatedBase = suffix.isEmpty() ? stripTrailingDotsAndSpaces(kept.toString())
				: kept.toString().stripTrailing();
		if (truncatedBase.isEmpty()) {
			truncatedBase = "attachment";
		}
		return truncatedBase + suffix;
	}

	private static String stripLeadingDotsAndSpaces(String s) {
		int i = 0;
		while (i < s.length() && (s.charAt(i) == '.' || s.charAt(i) == ' ')) {
			i++;
		}
		return s.substring(i);
	}

	private static String stripTrailingDotsAndSpaces(String s) {
		int end = s.length();
		while (end > 0 && (s.charAt(end - 1) == '.' || s.charAt(end - 1) == ' ')) {
			end--;
		}
		return s.substring(0, end);
	}

	private static boolean isWhitespace(char c) {
		return Character.isWhitespace(c) || Character.isSpaceChar(c);
	}

}
