package com.rjgehan.notes.vault;

import java.util.Locale;

/**
 * String helpers for vault paths ({@code /}-separated, no leading or trailing slash, {@code ""} is the root folder).
 */
public final class PathNames {

	private PathNames() {
	}

	/** The case-folding key used for every case-insensitive comparison. */
	public static String lower(String path) {
		return path.toLowerCase(Locale.ROOT);
	}

	/** The last segment. */
	public static String nameOf(String path) {
		int slash = path.lastIndexOf('/');
		return slash < 0 ? path : path.substring(slash + 1);
	}

	/** The parent folder, {@code ""} for an entry at the root. */
	public static String parentOf(String path) {
		int slash = path.lastIndexOf('/');
		return slash < 0 ? "" : path.substring(0, slash);
	}

	/** Joins a folder ({@code ""} for the root) and a relative path. */
	public static String join(String folder, String child) {
		if (folder.isEmpty()) {
			return child;
		}
		if (child.isEmpty()) {
			return folder;
		}
		return folder + "/" + child;
	}

	public static int segmentCount(String path) {
		if (path.isEmpty()) {
			return 0;
		}
		int count = 1;
		for (int i = 0; i < path.length(); i++) {
			if (path.charAt(i) == '/') {
				count++;
			}
		}
		return count;
	}

	/** True when {@code path} equals {@code folder} or lies under it (exact case). */
	public static boolean isAtOrUnder(String path, String folder) {
		return folder.isEmpty() || path.equals(folder) || path.startsWith(folder + "/");
	}

	/**
	 * The lower-cased final extension without the dot, or {@code ""}. A name without a dot, or whose only dot is the
	 * first character, has no extension (API.md §7).
	 */
	public static String extensionOf(String name) {
		int dot = name.lastIndexOf('.');
		if (dot <= 0 || dot == name.length() - 1) {
			return "";
		}
		return lower(name.substring(dot + 1));
	}

	/** The name without its final extension. */
	public static String basenameOf(String name) {
		int dot = name.lastIndexOf('.');
		if (dot <= 0 || dot == name.length() - 1) {
			return name;
		}
		return name.substring(0, dot);
	}

	/** True when the name ends in {@code .md}, ignoring case. */
	public static boolean isMarkdown(String name) {
		return name.length() > 3 && name.regionMatches(true, name.length() - 3, ".md", 0, 3);
	}

}
