package com.rjgehan.notes.ai;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

import com.rjgehan.notes.index.Tokenizer;

/**
 * Cuts a note down to a character budget. A note that fits is sent whole. Otherwise, when there are search terms, the
 * paragraphs (blocks separated by blank lines) with the most occurrences of the terms are kept, in document order,
 * with {@code […]} where text was left out; without terms, or when no paragraph has a term, the beginning is kept. The
 * result depends only on the text, the terms and the budget, so an earlier turn of a conversation is rebuilt byte for
 * byte and its prompt prefix stays in the cache.
 */
final class Excerpts {

	static final String GAP = "[…]";

	private static final String SEPARATOR = "\n\n" + GAP + "\n\n";

	record Excerpt(String text, boolean truncated) {
	}

	private record Paragraph(int index, int from, int to, int score) {

		int length() {
			return this.to - this.from;
		}

	}

	private Excerpts() {
	}

	static Excerpt select(String text, List<String> terms, int budget) {
		if (text.length() <= budget) {
			return new Excerpt(text, false);
		}
		if (!terms.isEmpty()) {
			Excerpt relevant = relevant(text, Set.copyOf(terms), budget);
			if (relevant != null) {
				return relevant;
			}
		}
		return new Excerpt(head(text, budget - SEPARATOR.length()) + "\n\n" + GAP, true);
	}

	private static Excerpt relevant(String text, Set<String> terms, int budget) {
		List<Paragraph> paragraphs = paragraphs(text, terms);
		List<Paragraph> ranked = paragraphs.stream()
			.filter((p) -> p.score() > 0)
			.sorted(Comparator.comparingInt(Paragraph::score).reversed().thenComparingInt(Paragraph::index))
			.toList();
		if (ranked.isEmpty()) {
			return null;
		}
		List<Paragraph> chosen = new ArrayList<>();
		int used = 0;
		for (Paragraph p : ranked) {
			int cost = p.length() + SEPARATOR.length();
			if (used + cost <= budget) {
				chosen.add(p);
				used += cost;
			}
		}
		if (chosen.isEmpty()) {
			// The best paragraph alone is too long: keep the part of it around its first match.
			Paragraph best = ranked.get(0);
			int match = firstMatch(text, best, terms);
			int size = budget - 2 * SEPARATOR.length();
			int from = Math.max(best.from(), Math.min(match - size / 2, best.to() - size));
			int to = Math.min(best.to(), from + size);
			return new Excerpt(GAP + "\n\n" + safe(text, from, to) + "\n\n" + GAP, true);
		}
		chosen.sort(Comparator.comparingInt(Paragraph::index));
		StringBuilder out = new StringBuilder();
		if (chosen.get(0).index() > 0) {
			out.append(GAP).append("\n\n");
		}
		Paragraph previous = null;
		for (Paragraph p : chosen) {
			if (previous != null) {
				out.append((p.index() == previous.index() + 1) ? "\n\n" : SEPARATOR);
			}
			out.append(text, p.from(), p.to());
			previous = p;
		}
		if (previous != null && previous.index() < paragraphs.size() - 1) {
			out.append("\n\n").append(GAP);
		}
		return new Excerpt(out.toString(), true);
	}

	/** The paragraphs of the text with the number of term occurrences in each. */
	private static List<Paragraph> paragraphs(String text, Set<String> terms) {
		List<Paragraph> paragraphs = new ArrayList<>();
		int lineStart = 0;
		int from = -1;
		int to = -1;
		while (true) {
			int newline = text.indexOf('\n', lineStart);
			int lineEnd = (newline < 0) ? text.length() : newline;
			if (!text.substring(lineStart, lineEnd).isBlank()) {
				if (from < 0) {
					from = lineStart;
				}
				to = lineEnd;
			}
			else if (from >= 0) {
				paragraphs.add(paragraph(text, paragraphs.size(), from, to, terms));
				from = -1;
			}
			if (newline < 0) {
				break;
			}
			lineStart = newline + 1;
		}
		if (from >= 0) {
			paragraphs.add(paragraph(text, paragraphs.size(), from, to, terms));
		}
		return paragraphs;
	}

	private static Paragraph paragraph(String text, int index, int from, int to, Set<String> terms) {
		int end = trimEnd(text, from, to);
		int score = 0;
		for (Tokenizer.Token token : Tokenizer.tokenize(text, from, end)) {
			if (terms.contains(token.term())) {
				score++;
			}
		}
		return new Paragraph(index, from, end, score);
	}

	private static int trimEnd(String text, int from, int to) {
		int end = to;
		while (end > from && Character.isWhitespace(text.charAt(end - 1))) {
			end--;
		}
		return end;
	}

	private static int firstMatch(String text, Paragraph p, Set<String> terms) {
		for (Tokenizer.Token token : Tokenizer.tokenize(text, p.from(), p.to())) {
			if (terms.contains(token.term())) {
				return token.from();
			}
		}
		return p.from();
	}

	/** The first {@code budget} characters, cut after the last line break when there is one in the second half. */
	static String head(String text, int budget) {
		int size = Math.max(0, Math.min(budget, text.length()));
		int newline = text.lastIndexOf('\n', size);
		int cut = (newline > size / 2) ? newline : size;
		return safe(text, 0, cut).stripTrailing();
	}

	/** A substring that never splits a surrogate pair. */
	private static String safe(String text, int from, int to) {
		int start = (from > 0 && from < text.length() && Character.isLowSurrogate(text.charAt(from))) ? from + 1 : from;
		int end = (to > 0 && to < text.length() && Character.isLowSurrogate(text.charAt(to))) ? to - 1 : to;
		return text.substring(start, Math.max(start, end));
	}

}
