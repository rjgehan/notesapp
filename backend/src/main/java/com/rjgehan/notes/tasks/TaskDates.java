package com.rjgehan.notes.tasks;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.regex.Pattern;

import org.jspecify.annotations.Nullable;

/**
 * Task dates are local: {@code YYYY-MM-DD} for an all-day date and {@code YYYY-MM-DDTHH:mm} for a date with a time,
 * both in the user's own time zone, which the server never needs to know for storing them (ROADMAP item 4).
 */
final class TaskDates {

	static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("uuuu-MM-dd")
		.withResolverStyle(ResolverStyle.STRICT);

	static final DateTimeFormatter DATE_TIME = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm")
		.withResolverStyle(ResolverStyle.STRICT);

	private static final Pattern DATE_SHAPE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

	private static final Pattern DATE_TIME_SHAPE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}");

	private TaskDates() {
	}

	/** A valid {@code YYYY-MM-DD} or {@code YYYY-MM-DDTHH:mm}. */
	static boolean isValid(@Nullable String value) {
		return isDate(value) || isDateTime(value);
	}

	static boolean isDate(@Nullable String value) {
		if (value == null || !DATE_SHAPE.matcher(value).matches()) {
			return false;
		}
		try {
			LocalDate.parse(value, DATE);
			return true;
		}
		catch (DateTimeParseException ex) {
			return false;
		}
	}

	static boolean isDateTime(@Nullable String value) {
		if (value == null || !DATE_TIME_SHAPE.matcher(value).matches()) {
			return false;
		}
		try {
			LocalDateTime.parse(value, DATE_TIME);
			return true;
		}
		catch (DateTimeParseException ex) {
			return false;
		}
	}

	/** The date part of a valid value. */
	static LocalDate date(String value) {
		return LocalDate.parse(value.substring(0, 10), DATE);
	}

	/** A valid value as a date-time; an all-day date is its start of day. */
	static LocalDateTime dateTime(String value) {
		return isDateTime(value) ? LocalDateTime.parse(value, DATE_TIME) : date(value).atStartOfDay();
	}

	/** The value moved by {@code days}, keeping its form (and its time). */
	static String plusDays(String value, long days) {
		if (isDateTime(value)) {
			return LocalDateTime.parse(value, DATE_TIME).plusDays(days).format(DATE_TIME);
		}
		return date(value).plusDays(days).format(DATE);
	}

	/** {@code date} with the time of {@code like} when that has one. */
	static String withTimeOf(LocalDate date, @Nullable String like) {
		if (like != null && isDateTime(like)) {
			LocalTime time = LocalDateTime.parse(like, DATE_TIME).toLocalTime();
			return date.atTime(time).format(DATE_TIME);
		}
		return date.format(DATE);
	}

	/** Chronological order; an all-day date sorts before the times of the same day. */
	static int compare(String a, String b) {
		int byDate = date(a).compareTo(date(b));
		if (byDate != 0) {
			return byDate;
		}
		boolean timedA = isDateTime(a);
		boolean timedB = isDateTime(b);
		if (timedA != timedB) {
			return timedA ? 1 : -1;
		}
		return a.compareTo(b);
	}

}
