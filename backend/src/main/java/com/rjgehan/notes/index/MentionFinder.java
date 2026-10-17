package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.TextRange;

/**
 * Unlinked mentions (DESIGN §5.5.9): whole-word, case-insensitive occurrences of a note's basename or aliases in
 * another note's text, outside code and other excluded zones, frontmatter, links (including a markdown link's text),
 * tags and bare URLs. Names shorter than three characters are ignored to avoid noise.
 */
public final class MentionFinder {

	public static final int MIN_NAME_LENGTH = 3;

	private static final Pattern URL = Pattern.compile("(?i)(?:\\b[a-z][a-z0-9+.-]*://|\\bwww\\.)[^\\s<>]*");

	private MentionFinder() {
	}

	/** One plain-text occurrence; {@code [from, to)} are offsets in the note's BOM-stripped text. */
	public record Found(int line, int from, int to, String matched) {
	}

	/** The names worth searching for: at least three characters, longest first, without duplicates. */
	public static List<String> usableNames(List<String> names) {
		return names.stream()
			.map(String::strip)
			.filter((name) -> name.codePointCount(0, name.length()) >= MIN_NAME_LENGTH)
			.distinct()
			.sorted(Comparator.comparingInt(String::length).reversed())
			.toList();
	}

	/** Occurrences of any of {@code names} (see {@link #usableNames}) in {@code text}, in text order. */
	public static List<Found> find(String text, NoteParse parse, List<String> names) {
		if (names.isEmpty()) {
			return List.of();
		}
		StringBuilder alternatives = new StringBuilder();
		for (String name : names) {
			if (!alternatives.isEmpty()) {
				alternatives.append('|');
			}
			alternatives.append(Pattern.quote(name));
		}
		Pattern pattern = Pattern.compile("(?<![\\p{L}\\p{N}_])(?:" + alternatives + ")(?![\\p{L}\\p{N}_])",
				Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
		Skipped skipped = new Skipped(text, parse);
		List<Found> found = new ArrayList<>();
		Matcher m = pattern.matcher(text);
		while (m.find()) {
			if (!skipped.overlaps(m.start(), m.end())) {
				found.add(new Found(lineOf(parse.lineStarts(), m.start()), m.start(), m.end(), m.group()));
			}
		}
		return found;
	}

	static int lineOf(int[] lineStarts, int offset) {
		int i = Arrays.binarySearch(lineStarts, offset);
		return (i >= 0) ? i : -i - 2;
	}

	/** Every range a mention may not touch. */
	private static final class Skipped {

		private final List<TextRange> ranges = new ArrayList<>();

		Skipped(String text, NoteParse parse) {
			this.ranges.addAll(parse.excluded());
			// Every link with its text, external markdown links included: linking a mention inside "[text](url)"
			// would break that link.
			this.ranges.addAll(parse.linkSpans());
			parse.links().forEach((link) -> this.ranges.add(new TextRange(link.from(), link.to())));
			parse.tags().forEach((tag) -> this.ranges.add(new TextRange(tag.from(), tag.to())));
			Matcher url = URL.matcher(text);
			while (url.find()) {
				this.ranges.add(new TextRange(url.start(), url.end()));
			}
		}

		boolean overlaps(int from, int to) {
			for (TextRange range : this.ranges) {
				if (from < range.to() && range.from() < to) {
					return true;
				}
			}
			return false;
		}

	}

}
