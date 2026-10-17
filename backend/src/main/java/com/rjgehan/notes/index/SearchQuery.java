package com.rjgehan.notes.index;

import java.util.List;

/** A parsed search query (API.md §12.1): every clause must match; negated clauses exclude. */
public record SearchQuery(List<Clause> clauses) {

	public enum Kind {

		/** Notes containing the word; a word that tokenizes into several tokens acts as a phrase. */
		WORD,

		/** Consecutive tokens. */
		PHRASE,

		/** Notes tagged {@code value} or any nested {@code value/…}. */
		TAG,

		/** A case-insensitive substring of the full vault path. */
		PATH,

		/** A case-insensitive substring of the file name. */
		FILE

	}

	public record Clause(Kind kind, String value, boolean negated) {

		public boolean isText() {
			return this.kind == Kind.WORD || this.kind == Kind.PHRASE;
		}

	}

	public SearchQuery {
		clauses = List.copyOf(clauses);
	}

	/** True when nothing positive is asked for: the query matches no notes at all. */
	public boolean matchesNothing() {
		return this.clauses.stream().allMatch(Clause::negated);
	}

}
