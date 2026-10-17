package com.rjgehan.notes.tasks;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.regex.Pattern;

/**
 * Monotonic ULIDs (26 Crockford base-32 characters: a 48-bit millisecond timestamp, then 80 random bits). Ids made in
 * the same millisecond increment the random part, so ids sort in creation order, which keeps a list file sorted by id
 * in creation order too.
 */
final class Ulid {

	private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();

	static final Pattern PATTERN = Pattern.compile("[0-9A-HJKMNP-TV-Z]{26}");

	private final Clock clock;

	private final SecureRandom random = new SecureRandom();

	private long lastMillis = -1;

	/** The 80 random bits: the high 16 and the low 64. */
	private int randomHigh;

	private long randomLow;

	Ulid(Clock clock) {
		this.clock = clock;
	}

	synchronized String next() {
		long millis = this.clock.millis();
		if (millis <= this.lastMillis) {
			millis = this.lastMillis;
			// Same (or an earlier) millisecond: increment the random part, carrying into the high bits.
			this.randomLow++;
			if (this.randomLow == 0) {
				this.randomHigh = (this.randomHigh + 1) & 0xFFFF;
			}
		}
		else {
			this.lastMillis = millis;
			this.randomHigh = this.random.nextInt() & 0xFFFF;
			this.randomLow = this.random.nextLong();
		}
		char[] out = new char[26];
		long time = millis;
		for (int i = 9; i >= 0; i--) {
			out[i] = ALPHABET[(int) (time & 31)];
			time >>>= 5;
		}
		// 80 bits as 16 base-32 digits, most significant first.
		long low = this.randomLow;
		long high = this.randomHigh;
		for (int i = 25; i >= 10; i--) {
			out[i] = ALPHABET[(int) (low & 31)];
			low = (low >>> 5) | ((high & 31) << 59);
			high >>>= 5;
		}
		return new String(out);
	}

}
