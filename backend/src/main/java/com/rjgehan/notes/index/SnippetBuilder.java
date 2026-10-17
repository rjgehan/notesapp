package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import com.rjgehan.notes.api.dto.SearchMatch;
import com.rjgehan.notes.api.dto.TextRange;

/**
 * Search snippets (DESIGN §5.5.10): up to three matching body lines per hit, each clipped to 200 characters around
 * its first match, with highlight ranges relative to the clipped text, plus the highlight ranges in the title. A
 * phrase highlights its whole span. Also clips context lines for backlinks.
 */
public final class SnippetBuilder {

	/** The longest snippet line. */
	public static final int MATCH_WIDTH = 200;

	public static final int MAX_LINES = 3;

	static final String ELLIPSIS = "…";

	private SnippetBuilder() {
	}

	public record Snippets(List<TextRange> titleRanges, List<SearchMatch> matches, int moreMatches) {
	}

	/** A clipped line and the ranges inside it. */
	public record Clipped(String text, List<TextRange> ranges) {
	}

	public static Snippets build(String basename, String text, NoteParse parse, List<TermPattern> patterns) {
		List<TextRange> titleRanges = ranges(Tokenizer.tokenize(basename), patterns, 0);
		List<SearchMatch> matches = new ArrayList<>();
		int more = 0;
		if (!patterns.isEmpty()) {
			int[] lineStarts = parse.lineStarts();
			Frontmatter frontmatter = parse.frontmatter();
			int firstLine = (frontmatter != null) ? frontmatter.closingLine() + 1 : 0;
			for (int line = firstLine; line < lineStarts.length; line++) {
				int start = lineStarts[line];
				int end = MarkdownScanner.contentEnd(text, lineStarts, line);
				List<TextRange> found = ranges(Tokenizer.tokenize(text, start, end), patterns, start);
				if (found.isEmpty()) {
					continue;
				}
				if (matches.size() == MAX_LINES) {
					more++;
					continue;
				}
				Clipped clipped = clip(text.substring(start, end), found, MATCH_WIDTH);
				matches.add(new SearchMatch(line, clipped.text(), clipped.ranges()));
			}
		}
		return new Snippets(titleRanges, matches, more);
	}

	/**
	 * Clips {@code line} to at most {@code width} characters centred on the first range, marking a clip with
	 * {@code …}; the ranges are shifted to the clipped text and cut to it.
	 */
	public static Clipped clip(String line, List<TextRange> ranges, int width) {
		if (line.length() <= width) {
			return new Clipped(line, ranges);
		}
		TextRange focus = ranges.isEmpty() ? new TextRange(0, 0) : ranges.get(0);
		int center = focus.from() + Math.min(focus.to() - focus.from(), width / 2) / 2;
		int start = Math.max(0, center - width / 2);
		int end = Math.min(line.length(), start + width);
		start = Math.max(0, end - width);
		boolean lead = start > 0;
		boolean trail = end < line.length();
		if (lead) {
			start++;
		}
		if (trail) {
			end--;
		}
		if (start > 0 && start < line.length() && Character.isLowSurrogate(line.charAt(start))) {
			start++;
		}
		if (end > start && Character.isHighSurrogate(line.charAt(end - 1))) {
			end--;
		}
		int shift = (lead ? ELLIPSIS.length() : 0) - start;
		List<TextRange> shifted = new ArrayList<>();
		for (TextRange range : ranges) {
			int from = Math.max(range.from(), start);
			int to = Math.min(range.to(), end);
			if (from < to) {
				shifted.add(new TextRange(from + shift, to + shift));
			}
		}
		String text = (lead ? ELLIPSIS : "") + line.substring(start, end) + (trail ? ELLIPSIS : "");
		return new Clipped(text, shifted);
	}

	/** The merged ranges, relative to {@code base}, where any pattern occurs in {@code tokens}. */
	static List<TextRange> ranges(List<Tokenizer.Token> tokens, List<TermPattern> patterns, int base) {
		List<TextRange> found = new ArrayList<>();
		for (TermPattern pattern : patterns) {
			for (TextRange range : pattern.occurrences(tokens)) {
				found.add(new TextRange(range.from() - base, range.to() - base));
			}
		}
		if (found.size() < 2) {
			return found;
		}
		found.sort(Comparator.comparingInt(TextRange::from).thenComparingInt(TextRange::to));
		List<TextRange> merged = new ArrayList<>();
		TextRange current = found.get(0);
		for (int i = 1; i < found.size(); i++) {
			TextRange next = found.get(i);
			if (next.from() <= current.to()) {
				current = new TextRange(current.from(), Math.max(current.to(), next.to()));
			}
			else {
				merged.add(current);
				current = next;
			}
		}
		merged.add(current);
		return merged;
	}

}
