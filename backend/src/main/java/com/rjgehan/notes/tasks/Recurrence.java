package com.rjgehan.notes.tasks;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.RecurrenceFrom;
import org.dmfs.rfc5545.DateTime;
import org.dmfs.rfc5545.recur.InvalidRecurrenceRuleException;
import org.dmfs.rfc5545.recur.RecurrenceRule;
import org.dmfs.rfc5545.recur.RecurrenceRuleIterator;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Recurring tasks (ROADMAP item 4): an RFC 5545 {@code RRULE} subset, evaluated with lib-recur. Completing a
 * recurring task rolls it forward to its next occurrence, counted from its due date (skipping occurrences that are
 * already past on the completion day) or from the completion day itself.
 * <p>
 * The subset: {@code FREQ} of {@code DAILY}, {@code WEEKLY}, {@code MONTHLY} or {@code YEARLY}, with {@code INTERVAL},
 * {@code BYDAY}, {@code BYMONTHDAY}, {@code BYMONTH}, {@code BYYEARDAY}, {@code BYWEEKNO}, {@code BYSETPOS},
 * {@code WKST}, {@code BYHOUR}, {@code BYMINUTE}, and either {@code COUNT} or {@code UNTIL}. Task dates are local, so
 * rules are evaluated on floating (zone-less) dates and times. {@code COUNT} is the number of occurrences left: each
 * roll-forward decrements it, and completing the last one closes the task. {@code UNTIL} is compared by date.
 */
final class Recurrence {

	private static final Logger logger = LoggerFactory.getLogger(Recurrence.class);

	static final int MAX_LENGTH = 300;

	private static final Set<String> PARTS = Set.of("FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY",
			"BYMONTH", "BYYEARDAY", "BYWEEKNO", "BYSETPOS", "WKST", "BYHOUR", "BYMINUTE");

	private static final Set<String> FREQUENCIES = Set.of("DAILY", "WEEKLY", "MONTHLY", "YEARLY");

	private static final Pattern NUMBER = Pattern.compile("[1-9][0-9]{0,4}");

	private static final Pattern UNTIL = Pattern.compile("(\\d{8})(T\\d{6}Z?)?");

	/** How many instances are examined for one next occurrence after fast-forwarding. */
	private static final int MAX_STEPS = 1000;

	private static final LocalDate PROBE_START = LocalDate.of(2026, 1, 1);

	/** The next occurrence ({@code YYYY-MM-DD} or {@code YYYY-MM-DDTHH:mm}) and the rule to store from then on. */
	record Next(String value, String rrule) {
	}

	private Recurrence() {
	}

	/**
	 * The rule as stored: without an {@code RRULE:} prefix, upper case, parts in the given order.
	 * @throws IllegalArgumentException with a message for the client when the rule is not in the supported subset
	 * or never produces an occurrence
	 */
	static String normalize(String rrule) {
		String rule = rrule.strip();
		if (rule.regionMatches(true, 0, "RRULE:", 0, 6)) {
			rule = rule.substring(6).strip();
		}
		if (rule.isEmpty() || rule.length() > MAX_LENGTH || rule.indexOf('\n') >= 0 || rule.indexOf('\r') >= 0) {
			throw new IllegalArgumentException("must be a single RRULE of at most " + MAX_LENGTH + " characters");
		}
		Map<String, String> parts = parts(rule.toUpperCase(Locale.ROOT));
		String freq = parts.get("FREQ");
		if (freq == null || !FREQUENCIES.contains(freq)) {
			throw new IllegalArgumentException("FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY");
		}
		for (String numeric : new String[] { "INTERVAL", "COUNT" }) {
			String value = parts.get(numeric);
			if (value != null && !NUMBER.matcher(value).matches()) {
				throw new IllegalArgumentException(numeric + " must be a whole number from 1 to 99999");
			}
		}
		if (parts.containsKey("COUNT") && parts.containsKey("UNTIL")) {
			throw new IllegalArgumentException("COUNT and UNTIL cannot be combined");
		}
		String until = parts.get("UNTIL");
		if (until != null && untilDate(until) == null) {
			throw new IllegalArgumentException("UNTIL must be a date (YYYYMMDD) or a date-time (YYYYMMDDTHHMMSSZ)");
		}
		Map<String, String> unbounded = new LinkedHashMap<>(parts);
		unbounded.remove("COUNT");
		unbounded.remove("UNTIL");
		String probe = join(unbounded);
		try {
			new RecurrenceRule(probe, RecurrenceRule.RfcMode.RFC5545_STRICT);
		}
		catch (InvalidRecurrenceRuleException | RuntimeException ex) {
			throw new IllegalArgumentException("is not a valid RRULE: " + ex.getMessage());
		}
		// A rule such as "every February 30th" parses but has no occurrences.
		if (next(probe, RecurrenceFrom.COMPLETION, null, PROBE_START) == null
				&& next(probe, RecurrenceFrom.COMPLETION, PROBE_START + "T09:00", PROBE_START) == null) {
			throw new IllegalArgumentException("never repeats");
		}
		return join(parts);
	}

	/**
	 * The occurrence after the one being completed, or null when the rule has no more (or cannot be evaluated).
	 * {@code anchor} is the task's due date, or its start date when it has no due date, or null. Counting from the due
	 * date, the next occurrence is the first one after the anchor that falls after the completion day, so completing
	 * an overdue task skips the occurrences already missed; counting from completion, it is the first one after the
	 * completion day (at the anchor's time, if it has one).
	 */
	static @Nullable Next next(String rrule, RecurrenceFrom from, @Nullable String anchor, LocalDate completionDay) {
		try {
			Map<String, String> parts = parts(rrule);
			String countValue = parts.remove("COUNT");
			String untilValue = parts.remove("UNTIL");
			Integer count = (countValue != null) ? Integer.valueOf(countValue) : null;
			if (count != null && count <= 1) {
				return null;
			}
			LocalDate until = (untilValue != null) ? untilDate(untilValue) : null;
			boolean timed = anchor != null && TaskDates.isDateTime(anchor);
			if (!timed) {
				parts.remove("BYHOUR");
				parts.remove("BYMINUTE");
			}
			boolean fromDue = from == RecurrenceFrom.DUE && anchor != null;
			LocalDateTime start = fromDue ? TaskDates.dateTime(anchor)
					: TaskDates.dateTime(TaskDates.withTimeOf(completionDay, anchor));
			LocalDate earliest = fromDue ? completionDay.plusDays(1) : null;
			RecurrenceRule rule = new RecurrenceRule(join(parts), RecurrenceRule.RfcMode.RFC5545_LAX);
			RecurrenceRuleIterator iterator = rule.iterator(toDateTime(start, timed));
			if (earliest != null && earliest.isAfter(start.toLocalDate())) {
				iterator.fastForward(toDateTime(earliest.atStartOfDay(), timed));
			}
			for (int i = 0; i < MAX_STEPS && iterator.hasNext(); i++) {
				LocalDateTime occurrence = toLocal(iterator.nextDateTime());
				if (!occurrence.isAfter(start) || (earliest != null && occurrence.toLocalDate().isBefore(earliest))) {
					continue;
				}
				if (until != null && occurrence.toLocalDate().isAfter(until)) {
					return null;
				}
				String value = timed ? occurrence.format(TaskDates.DATE_TIME)
						: occurrence.toLocalDate().format(TaskDates.DATE);
				return new Next(value, (count != null) ? withCount(rrule, count - 1) : rrule);
			}
			return null;
		}
		catch (InvalidRecurrenceRuleException | RuntimeException ex) {
			logger.debug("Cannot evaluate the recurrence rule {}: {}", rrule, ex.toString());
			return null;
		}
	}

	/** The rule's parts, upper case, in order; rejects unknown and repeated parts. */
	private static Map<String, String> parts(String rule) {
		Map<String, String> parts = new LinkedHashMap<>();
		for (String part : rule.split(";")) {
			if (part.isEmpty()) {
				continue;
			}
			int equals = part.indexOf('=');
			if (equals <= 0 || equals == part.length() - 1) {
				throw new IllegalArgumentException("each part must be NAME=VALUE");
			}
			String name = part.substring(0, equals).toUpperCase(Locale.ROOT);
			if (!PARTS.contains(name)) {
				throw new IllegalArgumentException(name + " is not supported");
			}
			if (parts.put(name, part.substring(equals + 1).toUpperCase(Locale.ROOT)) != null) {
				throw new IllegalArgumentException(name + " appears twice");
			}
		}
		return parts;
	}

	private static String join(Map<String, String> parts) {
		return parts.entrySet().stream().map((e) -> e.getKey() + "=" + e.getValue()).collect(Collectors.joining(";"));
	}

	private static String withCount(String rrule, int count) {
		Map<String, String> parts = parts(rrule);
		parts.put("COUNT", Integer.toString(count));
		return join(parts);
	}

	private static @Nullable LocalDate untilDate(String value) {
		var matcher = UNTIL.matcher(value);
		if (!matcher.matches()) {
			return null;
		}
		String digits = matcher.group(1);
		String date = digits.substring(0, 4) + "-" + digits.substring(4, 6) + "-" + digits.substring(6, 8);
		return TaskDates.isDate(date) ? TaskDates.date(date) : null;
	}

	private static DateTime toDateTime(LocalDateTime value, boolean timed) {
		if (!timed) {
			return new DateTime(value.getYear(), value.getMonthValue() - 1, value.getDayOfMonth());
		}
		return new DateTime(value.getYear(), value.getMonthValue() - 1, value.getDayOfMonth(), value.getHour(),
				value.getMinute(), 0);
	}

	private static LocalDateTime toLocal(DateTime value) {
		if (value.isAllDay()) {
			return LocalDate.of(value.getYear(), value.getMonth() + 1, value.getDayOfMonth()).atStartOfDay();
		}
		return LocalDateTime.of(value.getYear(), value.getMonth() + 1, value.getDayOfMonth(), value.getHours(),
				value.getMinutes());
	}

}
