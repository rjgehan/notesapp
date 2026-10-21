package com.rjgehan.notes.index;

import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Regular expressions in search queries (API.md §12.1), kept safe against catastrophic backtracking: a pattern is at
 * most {@value #MAX_LENGTH} characters, and every match runs over a {@link Budget} shared by the whole query, which
 * aborts with {@link TimeoutException} once its deadline passes. Java's backtracking engine reads the input through
 * {@link CharSequence#charAt}, so a text wrapped in {@link #text} checks the clock while the engine works, also in
 * the middle of one pathological match.
 * <p>
 * Patterns are case-insensitive (Unicode-aware) unless they turn it off with {@code (?-i)}; {@code ^} and {@code $}
 * match at line breaks ({@code MULTILINE}).
 */
public final class SearchRegex {

	/** The longest pattern accepted. */
	public static final int MAX_LENGTH = 500;

	/** How often (in characters read) a budgeted text looks at the clock. */
	private static final int CHECK_EVERY = 2048;

	private SearchRegex() {
	}

	/** An invalid or too long pattern; the message is meant for the user. */
	public static final class InvalidException extends RuntimeException {

		private final String pattern;

		InvalidException(String pattern, String message) {
			super(message);
			this.pattern = pattern;
		}

		public String pattern() {
			return this.pattern;
		}

	}

	/** A query's regular expressions ran out of time. */
	public static final class TimeoutException extends RuntimeException {

		public TimeoutException() {
			super("The regular expression took too long");
		}

		public TimeoutException(Throwable cause) {
			super("The regular expression took too long", cause);
		}

	}

	/** Compiles a pattern from a query, or throws {@link InvalidException}. */
	public static Pattern compile(String source) {
		if (source.length() > MAX_LENGTH) {
			throw new InvalidException(source,
					"The regular expression is longer than " + MAX_LENGTH + " characters");
		}
		try {
			return Pattern.compile(source, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE | Pattern.MULTILINE);
		}
		catch (PatternSyntaxException ex) {
			throw new InvalidException(source, "Invalid regular expression /" + source + "/: " + ex.getDescription()
					+ ((ex.getIndex() >= 0) ? " near position " + ex.getIndex() : ""));
		}
	}

	/** The time one query's regular expressions may take together. Thread-safe. */
	public static final class Budget {

		private final long deadline;

		private volatile boolean exceeded;

		public Budget(Duration limit) {
			this.deadline = System.nanoTime() + limit.toNanos();
		}

		/** A budget that never runs out (tests). */
		public static Budget unlimited() {
			return new Budget(Duration.ofDays(365));
		}

		public void check() {
			if (this.exceeded || System.nanoTime() - this.deadline > 0) {
				this.exceeded = true;
				throw new TimeoutException();
			}
		}

		public boolean exceeded() {
			return this.exceeded;
		}

	}

	/** {@code text} as seen by a matcher, checking {@code budget} as it is read. */
	public static CharSequence text(String text, Budget budget) {
		return new BudgetedText(text, budget);
	}

	/** True when {@code pattern} occurs in {@code text} between {@code from} and {@code to}. */
	public static boolean find(Pattern pattern, CharSequence text, int from, int to) {
		Matcher matcher = pattern.matcher(text);
		matcher.region(from, to);
		return matcher.find();
	}

	private static final class BudgetedText implements CharSequence {

		private final String text;

		private final Budget budget;

		private int reads;

		BudgetedText(String text, Budget budget) {
			this.text = text;
			this.budget = budget;
		}

		@Override
		public int length() {
			return this.text.length();
		}

		@Override
		public char charAt(int index) {
			if (++this.reads == CHECK_EVERY) {
				this.reads = 0;
				this.budget.check();
			}
			return this.text.charAt(index);
		}

		@Override
		public CharSequence subSequence(int start, int end) {
			return this.text.subSequence(start, end);
		}

		@Override
		public String toString() {
			return this.text;
		}

	}

}
