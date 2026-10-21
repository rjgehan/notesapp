package com.rjgehan.notes.ai;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.index.Tokenizer;

/**
 * The search terms of a question in natural language: its tokens, normalized like the index's ({@link Tokenizer}),
 * without common English words and single letters, at most {@value #MAX_TERMS} of them in order of appearance. Retrieval
 * ranks the notes that contain <em>any</em> of them with BM25 (ROADMAP item 18: the existing BM25 search; embeddings
 * come later).
 */
public final class QueryTerms {

	static final int MAX_TERMS = 32;

	private static final Set<String> STOP_WORDS = Set.of("a", "about", "above", "after", "again", "against", "all",
			"am", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
			"between", "both", "but", "by", "can", "could", "did", "do", "does", "doing", "done", "down", "during",
			"each", "else", "ever", "every", "few", "find", "for", "from", "further", "get", "give", "had", "has",
			"have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it",
			"its", "itself", "just", "know", "let", "like", "list", "me", "mention", "mentioned", "more", "most", "my",
			"myself", "no", "nor", "not", "note", "notes", "now", "of", "off", "on", "once", "only", "or", "other",
			"our", "ours", "out", "over", "own", "please", "said", "same", "say", "she", "should", "show", "so",
			"some", "such", "summarize", "summary", "tell", "than", "that", "the", "their", "theirs", "them", "then",
			"there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "us", "very",
			"vault", "was", "we", "were", "what", "whats", "when", "where", "which", "while", "who", "whom", "why",
			"will", "with", "would", "write", "wrote", "you", "your", "yours");

	private QueryTerms() {
	}

	public static List<String> of(String text) {
		Set<String> terms = new LinkedHashSet<>();
		for (Tokenizer.Token token : Tokenizer.tokenize(text)) {
			String term = token.term();
			if (STOP_WORDS.contains(term)) {
				continue;
			}
			if (term.length() == 1 && !Character.isDigit(term.charAt(0))
					&& !Character.isIdeographic(term.codePointAt(0)) && !isKana(term.codePointAt(0))) {
				continue;
			}
			terms.add(term);
			if (terms.size() == MAX_TERMS) {
				break;
			}
		}
		return new ArrayList<>(terms);
	}

	/**
	 * The terms that best describe a note, for finding related notes: its most frequent terms (title words count
	 * extra), at most {@code limit}.
	 */
	public static List<String> describing(String title, String text, int limit) {
		Map<String, Integer> counts = new HashMap<>();
		for (String term : of(title)) {
			counts.merge(term, 5, Integer::sum);
		}
		for (Tokenizer.Token token : Tokenizer.tokenize(text)) {
			String term = token.term();
			if (term.length() < 3 || STOP_WORDS.contains(term) || term.chars().allMatch(Character::isDigit)) {
				continue;
			}
			counts.merge(term, 1, Integer::sum);
		}
		return counts.entrySet().stream()
			.sorted(Map.Entry.<String, Integer>comparingByValue().reversed()
				.thenComparing(Map.Entry.comparingByKey()))
			.limit(limit)
			.map(Map.Entry::getKey)
			.toList();
	}

	private static boolean isKana(int codePoint) {
		Character.UnicodeBlock block = Character.UnicodeBlock.of(codePoint);
		return block == Character.UnicodeBlock.HIRAGANA || block == Character.UnicodeBlock.KATAKANA;
	}

}
