package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.TextRange;

/**
 * The normalized terms of a word or phrase clause. They must appear as consecutive tokens; with {@code prefixLast}
 * (search-as-you-type), the last term also matches any token that starts with it.
 */
public record TermPattern(List<String> terms, boolean prefixLast) {

	public TermPattern {
		terms = List.copyOf(terms);
	}

	public boolean isPhrase() {
		return this.terms.size() > 1;
	}

	/** True when {@code term} matches position {@code index} of the pattern. */
	public boolean matches(int index, String term) {
		String expected = this.terms.get(index);
		return (this.prefixLast && index == this.terms.size() - 1) ? term.startsWith(expected) : term.equals(expected);
	}

	/** The character ranges where the whole pattern occurs in {@code tokens}, each spanning all its tokens. */
	public List<TextRange> occurrences(List<Tokenizer.Token> tokens) {
		List<TextRange> found = new ArrayList<>();
		int size = this.terms.size();
		for (int start = 0; start + size <= tokens.size(); start++) {
			boolean all = true;
			for (int k = 0; k < size && all; k++) {
				all = matches(k, tokens.get(start + k).term());
			}
			if (all) {
				found.add(new TextRange(tokens.get(start).from(), tokens.get(start + size - 1).to()));
			}
		}
		return found;
	}

	public boolean occursIn(List<Tokenizer.Token> tokens) {
		int size = this.terms.size();
		for (int start = 0; start + size <= tokens.size(); start++) {
			boolean all = true;
			for (int k = 0; k < size && all; k++) {
				all = matches(k, tokens.get(start + k).term());
			}
			if (all) {
				return true;
			}
		}
		return false;
	}

}
