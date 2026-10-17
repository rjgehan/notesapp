package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * Fractional-index order keys: strings that sort with plain string comparison and between any two of which a new key
 * can always be made, so moving one task changes only that task. This is the base-62 algorithm of the
 * {@code fractional-indexing} package (David Greenspan's "Implementing Fractional Indexing", as published by Rocicorp,
 * CC0), so a client may generate compatible keys itself: the first key is {@code a0}, then {@code a1}, ...
 */
public final class FractionalIndex {

	private static final String DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

	private static final String SMALLEST_INTEGER = "A" + "0".repeat(26);

	private FractionalIndex() {
	}

	/** True for a key this algorithm can generate around. */
	public static boolean isValid(@Nullable String key) {
		if (key == null) {
			return false;
		}
		try {
			validate(key);
			return true;
		}
		catch (IllegalArgumentException ex) {
			return false;
		}
	}

	/**
	 * A key strictly between {@code a} and {@code b} ({@code null} means unbounded).
	 * @throws IllegalArgumentException when a key is invalid or {@code a >= b}
	 */
	public static String between(@Nullable String a, @Nullable String b) {
		if (a != null) {
			validate(a);
		}
		if (b != null) {
			validate(b);
		}
		if (a != null && b != null && a.compareTo(b) >= 0) {
			throw new IllegalArgumentException(a + " >= " + b);
		}
		if (a == null) {
			if (b == null) {
				return "a0";
			}
			String ib = integerPart(b);
			String fb = b.substring(ib.length());
			if (ib.equals(SMALLEST_INTEGER)) {
				return ib + midpoint("", fb);
			}
			if (ib.compareTo(b) < 0) {
				return ib;
			}
			String decremented = decrementInteger(ib);
			if (decremented == null) {
				throw new IllegalArgumentException("cannot decrement any more");
			}
			return decremented;
		}
		if (b == null) {
			String ia = integerPart(a);
			String fa = a.substring(ia.length());
			String incremented = incrementInteger(ia);
			return (incremented == null) ? ia + midpoint(fa, null) : incremented;
		}
		String ia = integerPart(a);
		String fa = a.substring(ia.length());
		String ib = integerPart(b);
		String fb = b.substring(ib.length());
		if (ia.equals(ib)) {
			return ia + midpoint(fa, fb);
		}
		String incremented = incrementInteger(ia);
		if (incremented == null) {
			throw new IllegalArgumentException("cannot increment any more");
		}
		if (incremented.compareTo(b) < 0) {
			return incremented;
		}
		return ia + midpoint(fa, null);
	}

	/** {@code n} increasing keys strictly between {@code a} and {@code b}. */
	public static List<String> between(@Nullable String a, @Nullable String b, int n) {
		if (n <= 0) {
			return List.of();
		}
		if (n == 1) {
			return List.of(between(a, b));
		}
		List<String> result = new ArrayList<>(n);
		if (b == null) {
			String c = between(a, null);
			result.add(c);
			for (int i = 1; i < n; i++) {
				c = between(c, null);
				result.add(c);
			}
			return result;
		}
		if (a == null) {
			String c = between(null, b);
			result.add(c);
			for (int i = 1; i < n; i++) {
				c = between(null, c);
				result.add(c);
			}
			Collections.reverse(result);
			return result;
		}
		int mid = n / 2;
		String c = between(a, b);
		result.addAll(between(a, c, mid));
		result.add(c);
		result.addAll(between(c, b, n - mid - 1));
		return result;
	}

	private static String midpoint(String a, @Nullable String b) {
		if (b != null && a.compareTo(b) >= 0) {
			throw new IllegalArgumentException(a + " >= " + b);
		}
		if ((!a.isEmpty() && a.charAt(a.length() - 1) == '0') || (b != null && !b.isEmpty()
				&& b.charAt(b.length() - 1) == '0')) {
			throw new IllegalArgumentException("trailing zero");
		}
		if (b != null) {
			// Remove the longest common prefix, padding a with zeros as we go.
			int n = 0;
			while (n < b.length() && ((n < a.length()) ? a.charAt(n) : '0') == b.charAt(n)) {
				n++;
			}
			if (n > 0) {
				return b.substring(0, n) + midpoint((n < a.length()) ? a.substring(n) : "", b.substring(n));
			}
		}
		// The first digits (or the lack of a digit) differ.
		int digitA = a.isEmpty() ? 0 : DIGITS.indexOf(a.charAt(0));
		int digitB = (b != null) ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length();
		if (digitB - digitA > 1) {
			return String.valueOf(DIGITS.charAt((int) Math.round(0.5 * (digitA + digitB))));
		}
		// The first digits are consecutive.
		if (b != null && b.length() > 1) {
			return b.substring(0, 1);
		}
		return DIGITS.charAt(digitA) + midpoint(a.isEmpty() ? "" : a.substring(1), null);
	}

	/** The length of the integer part announced by a key's head, or 0 for an invalid head. */
	private static int integerLength(char head) {
		if (head >= 'a' && head <= 'z') {
			return head - 'a' + 2;
		}
		if (head >= 'A' && head <= 'Z') {
			return 'Z' - head + 2;
		}
		return 0;
	}

	private static String integerPart(String key) {
		int length = integerLength(key.charAt(0));
		if (length == 0 || length > key.length()) {
			throw new IllegalArgumentException("invalid order key: " + key);
		}
		return key.substring(0, length);
	}

	private static void validate(String key) {
		if (key.isEmpty() || key.equals(SMALLEST_INTEGER)) {
			throw new IllegalArgumentException("invalid order key: " + key);
		}
		for (int i = 0; i < key.length(); i++) {
			if (DIGITS.indexOf(key.charAt(i)) < 0) {
				throw new IllegalArgumentException("invalid order key: " + key);
			}
		}
		String integer = integerPart(key);
		String fraction = key.substring(integer.length());
		if (!fraction.isEmpty() && fraction.charAt(fraction.length() - 1) == '0') {
			throw new IllegalArgumentException("invalid order key: " + key);
		}
	}

	private static @Nullable String incrementInteger(String x) {
		char head = x.charAt(0);
		char[] digits = x.substring(1).toCharArray();
		boolean carry = true;
		for (int i = digits.length - 1; carry && i >= 0; i--) {
			int d = DIGITS.indexOf(digits[i]) + 1;
			if (d == DIGITS.length()) {
				digits[i] = '0';
			}
			else {
				digits[i] = DIGITS.charAt(d);
				carry = false;
			}
		}
		if (!carry) {
			return head + new String(digits);
		}
		if (head == 'Z') {
			return "a0";
		}
		if (head == 'z') {
			return null;
		}
		char h = (char) (head + 1);
		String rest = new String(digits);
		return (h > 'a') ? h + rest + "0" : h + rest.substring(0, rest.length() - 1);
	}

	private static @Nullable String decrementInteger(String x) {
		char head = x.charAt(0);
		char[] digits = x.substring(1).toCharArray();
		boolean borrow = true;
		for (int i = digits.length - 1; borrow && i >= 0; i--) {
			int d = DIGITS.indexOf(digits[i]) - 1;
			if (d == -1) {
				digits[i] = DIGITS.charAt(DIGITS.length() - 1);
			}
			else {
				digits[i] = DIGITS.charAt(d);
				borrow = false;
			}
		}
		if (!borrow) {
			return head + new String(digits);
		}
		if (head == 'a') {
			return "Z" + DIGITS.charAt(DIGITS.length() - 1);
		}
		if (head == 'A') {
			return null;
		}
		char h = (char) (head - 1);
		String rest = new String(digits);
		return (h < 'Z') ? h + rest + DIGITS.charAt(DIGITS.length() - 1) : h + rest.substring(0, rest.length() - 1);
	}

}
