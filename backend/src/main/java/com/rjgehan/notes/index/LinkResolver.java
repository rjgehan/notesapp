package com.rjgehan.notes.index;

import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.function.Predicate;

import com.rjgehan.notes.settings.NewNoteLocation;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Link resolution (DESIGN §5.5.6, API.md §15.1). Deterministic: the vault root first, then the source note's folder,
 * then a case-insensitive suffix match anywhere, ties broken by same folder, fewest segments, then lowest path. The
 * client runs the same algorithm over the tree.
 */
public final class LinkResolver {

	/** The two index views resolution needs. Implementations are called under the index lock. */
	public interface Lookup {

		/** Files whose lower-cased path equals {@code lowerPath} (usually one). */
		List<String> filesByLowerPath(String lowerPath);

		/** Files whose lower-cased last segment equals {@code lowerName}. */
		List<String> filesByLowerName(String lowerName);

	}

	private LinkResolver() {
	}

	/** The resolved file path (any kind), or null when the target is unresolved. */
	public static @Nullable String resolve(String rawTarget, String sourcePath, Lookup lookup) {
		String t = Syntax.trim(Normalizer.normalize(rawTarget, Normalizer.Form.NFC));
		if (t.isEmpty()) {
			return sourcePath;
		}
		boolean forcedAbsolute = t.startsWith("/");
		boolean forcedRelative = t.startsWith("./") || t.startsWith("../");
		if (forcedAbsolute) {
			t = t.substring(1);
		}
		List<String> candidates = endsWithMd(t) ? List.of(t) : List.of(t + ".md", t);
		if (!forcedRelative) {
			for (String c : candidates) {
				String hit = lookupLower(c, lookup);
				if (hit != null) {
					return hit;
				}
			}
		}
		if (!forcedAbsolute) {
			String folder = PathNames.parentOf(sourcePath);
			for (String c : candidates) {
				String p = normalizeDots(PathNames.join(folder, c));
				if (p == null) {
					continue;
				}
				String hit = lookupLower(p, lookup);
				if (hit != null) {
					return hit;
				}
			}
		}
		if (forcedAbsolute || forcedRelative) {
			return null;
		}
		String sourceFolder = PathNames.lower(PathNames.parentOf(sourcePath));
		Comparator<String> order = Comparator
			.<String>comparingInt((f) -> PathNames.lower(PathNames.parentOf(f)).equals(sourceFolder) ? 0 : 1)
			.thenComparingInt(PathNames::segmentCount)
			.thenComparing(PathNames::lower)
			.thenComparing(Comparator.naturalOrder());
		for (String c : candidates) {
			String lowerC = PathNames.lower(c);
			String suffix = "/" + lowerC;
			String best = null;
			for (String f : lookup.filesByLowerName(PathNames.nameOf(lowerC))) {
				String lowerF = PathNames.lower(f);
				if ((lowerF.equals(lowerC) || lowerF.endsWith(suffix)) && (best == null || order.compare(f, best) < 0)) {
					best = f;
				}
			}
			if (best != null) {
				return best;
			}
		}
		return null;
	}

	/**
	 * Where a note for an unresolved target would be created, or null when the target has a (non-{@code .md})
	 * extension or would not make a valid new name. Forced-relative targets resolve against the source's folder;
	 * forced-absolute targets and targets containing {@code /} start at the root; bare names go to the folder chosen by
	 * {@code newNoteLocation}.
	 */
	public static @Nullable String createPath(String rawTarget, String sourcePath, NewNoteLocation location,
			String newNoteFolder, Predicate<String> isKnownExtension) {
		String t = Syntax.trim(Normalizer.normalize(rawTarget, Normalizer.Form.NFC));
		if (t.isEmpty()) {
			return null;
		}
		boolean forcedAbsolute = t.startsWith("/");
		boolean forcedRelative = t.startsWith("./") || t.startsWith("../");
		if (forcedAbsolute) {
			t = t.substring(1);
		}
		boolean markdown = endsWithMd(t);
		if (!markdown) {
			String extension = PathNames.extensionOf(PathNames.nameOf(t));
			if (!extension.isEmpty() && isKnownExtension.test(extension)) {
				return null;
			}
		}
		String path;
		if (forcedRelative) {
			path = normalizeDots(PathNames.join(PathNames.parentOf(sourcePath), t));
		}
		else if (forcedAbsolute || t.contains("/")) {
			path = normalizeDots(t);
		}
		else {
			String folder = switch (location) {
				case ROOT -> "";
				case CURRENT -> PathNames.parentOf(sourcePath);
				case FOLDER -> newNoteFolder;
			};
			path = PathNames.join(folder, t);
		}
		if (path == null || path.isEmpty()) {
			return null;
		}
		if (!markdown) {
			path = path + ".md";
		}
		return NameRules.isValidNewPath(path) ? path : null;
	}

	/** The re-resolution bucket of a link target: its lower-cased last segment without {@code .md}. */
	public static String nameKey(String rawTarget) {
		String t = Syntax.trim(Normalizer.normalize(rawTarget, Normalizer.Form.NFC));
		return stripMd(PathNames.lower(PathNames.nameOf(t)));
	}

	/** The bucket a file belongs to; a link can only resolve to a file in its own bucket. */
	public static String fileNameKey(String path) {
		return stripMd(PathNames.lower(PathNames.nameOf(path)));
	}

	private static boolean endsWithMd(String t) {
		return t.length() >= 3 && t.regionMatches(true, t.length() - 3, ".md", 0, 3);
	}

	private static String stripMd(String lowerName) {
		return lowerName.endsWith(".md") ? lowerName.substring(0, lowerName.length() - 3) : lowerName;
	}

	/** Resolves {@code .} and {@code ..} segments; null when the path escapes the vault root. */
	static @Nullable String normalizeDots(String path) {
		Deque<String> out = new ArrayDeque<>();
		for (String segment : path.split("/", -1)) {
			if (segment.equals(".")) {
				continue;
			}
			if (segment.equals("..")) {
				if (out.isEmpty()) {
					return null;
				}
				out.removeLast();
				continue;
			}
			out.addLast(segment);
		}
		return String.join("/", out);
	}

	private static @Nullable String lookupLower(String candidate, Lookup lookup) {
		List<String> hits = lookup.filesByLowerPath(PathNames.lower(candidate));
		if (hits.isEmpty()) {
			return null;
		}
		if (hits.size() == 1) {
			return hits.get(0);
		}
		if (hits.contains(candidate)) {
			return candidate;
		}
		return hits.stream().min(Comparator.naturalOrder()).orElseThrow();
	}

}
