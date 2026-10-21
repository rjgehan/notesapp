package com.rjgehan.notes.index;

/**
 * Typo tolerance for search terms (DESIGN §5.5.10): the edit distance with adjacent transpositions (optimal string
 * alignment), computed only as far as a bound, and the rule for how many typos a term may have.
 */
public final class Fuzzy {

	private Fuzzy() {
	}

	/**
	 * How many edits a search term may be away from a vocabulary term: none below 4 characters or for terms with
	 * digits (a year or a version number is never "corrected"), one up to 7 characters, two from 8.
	 */
	public static int allowedEdits(String term) {
		int length = term.codePointCount(0, term.length());
		if (length < 4) {
			return 0;
		}
		for (int i = 0; i < term.length(); i++) {
			if (Character.isDigit(term.charAt(i))) {
				return 0;
			}
		}
		return (length < 8) ? 1 : 2;
	}

	/**
	 * The optimal string alignment distance between {@code a} and {@code b} (UTF-16 units), or {@code max + 1} as
	 * soon as it is known to exceed {@code max}.
	 */
	public static int distance(String a, String b, int max) {
		int n = a.length();
		int m = b.length();
		if (Math.abs(n - m) > max) {
			return max + 1;
		}
		int[] previous2 = new int[m + 1];
		int[] previous = new int[m + 1];
		int[] current = new int[m + 1];
		for (int j = 0; j <= m; j++) {
			previous[j] = j;
		}
		for (int i = 1; i <= n; i++) {
			current[0] = i;
			int rowMin = current[0];
			char ca = a.charAt(i - 1);
			for (int j = 1; j <= m; j++) {
				char cb = b.charAt(j - 1);
				int cost = (ca == cb) ? 0 : 1;
				int value = Math.min(Math.min(previous[j] + 1, current[j - 1] + 1), previous[j - 1] + cost);
				if (i > 1 && j > 1 && ca == b.charAt(j - 2) && a.charAt(i - 2) == cb) {
					value = Math.min(value, previous2[j - 2] + 1);
				}
				current[j] = value;
				rowMin = Math.min(rowMin, value);
			}
			if (rowMin > max) {
				return max + 1;
			}
			int[] recycled = previous2;
			previous2 = previous;
			previous = current;
			current = recycled;
		}
		return Math.min(previous[m], max + 1);
	}

}
