package com.rjgehan.notes.flashcards;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.Set;

import com.rjgehan.notes.config.JsonConfig;
import org.jspecify.annotations.Nullable;

/**
 * One answer to a card, stored as {@code "<instant> <rating>[ <ms>]"} (DESIGN §5.34): the time in API form (UTC,
 * milliseconds), the rating, and optionally how long the answer took. A card's reviews are a set keyed by time, so
 * the same answer sent twice is stored once and two devices' answers merge by union.
 */
public record ReviewEntry(Instant at, String rating, @Nullable Integer ms) {

	public static final Set<String> RATINGS = Set.of("again", "hard", "good", "easy", "reset");

	/** At most a day: anything longer is not the time an answer took. */
	public static final int MAX_MS = 86_400_000;

	public ReviewEntry {
		at = at.truncatedTo(ChronoUnit.MILLIS);
	}

	/** The stored form. */
	public String format() {
		return JsonConfig.formatInstant(this.at) + " " + this.rating + ((this.ms != null) ? " " + this.ms : "");
	}

	/** Parses the stored form; null when it is not one. */
	public static @Nullable ReviewEntry parse(String text) {
		String[] parts = text.trim().split(" +");
		if (parts.length < 2 || parts.length > 3) {
			return null;
		}
		Instant at = parseInstant(parts[0]);
		if (at == null || !RATINGS.contains(parts[1])) {
			return null;
		}
		Integer ms = null;
		if (parts.length == 3) {
			try {
				ms = Integer.valueOf(parts[2]);
			}
			catch (NumberFormatException ex) {
				return null;
			}
			if (ms < 0 || ms > MAX_MS) {
				return null;
			}
		}
		return new ReviewEntry(at, parts[1], ms);
	}

	/** An ISO-8601 instant, or null. */
	public static @Nullable Instant parseInstant(@Nullable String text) {
		if (text == null) {
			return null;
		}
		try {
			return Instant.parse(text);
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

}
