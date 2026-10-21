package com.rjgehan.notes.tasks;

import java.time.LocalDate;

import com.rjgehan.notes.api.dto.RecurrenceFrom;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Recurrence rules and the roll-forward dates (2026-10-14 is a Wednesday). */
class RecurrenceTest {

	private static final LocalDate WEDNESDAY = LocalDate.of(2026, 10, 14);

	@Test
	void rulesAreNormalized() {
		assertThat(Recurrence.normalize("RRULE:freq=weekly;byday=mo,we")).isEqualTo("FREQ=WEEKLY;BYDAY=MO,WE");
		assertThat(Recurrence.normalize(" FREQ=MONTHLY;BYMONTHDAY=1; ")).isEqualTo("FREQ=MONTHLY;BYMONTHDAY=1");
		assertThat(Recurrence.normalize("FREQ=DAILY;INTERVAL=3;COUNT=5")).isEqualTo("FREQ=DAILY;INTERVAL=3;COUNT=5");
		assertThat(Recurrence.normalize("FREQ=YEARLY;UNTIL=20301231")).isEqualTo("FREQ=YEARLY;UNTIL=20301231");
	}

	@ParameterizedTest
	@ValueSource(strings = { "", "FREQ=HOURLY", "BYDAY=MO", "FREQ=WEEKLY;FOO=1", "FREQ=DAILY;FREQ=WEEKLY",
			"FREQ=DAILY;COUNT=2;UNTIL=20300101", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;UNTIL=tomorrow",
			"FREQ=WEEKLY;BYDAY=XX", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "FREQ=DAILY\nFREQ=WEEKLY",
			"FREQ=DAILY;BYSECOND=1", "DTSTART:20260101", "FREQ=DAILY;INTERVAL" })
	void unsupportedRulesAreRejected(String rule) {
		assertThatThrownBy(() -> Recurrence.normalize(rule)).isInstanceOf(IllegalArgumentException.class);
	}

	@Test
	void fromDueCountsFromTheDueDate() {
		// Completed early (on Monday) for Wednesday: the next Wednesday.
		assertThat(next("FREQ=WEEKLY", RecurrenceFrom.DUE, "2026-10-14", LocalDate.of(2026, 10, 12)))
			.isEqualTo("2026-10-21");
		// Completed on time.
		assertThat(next("FREQ=WEEKLY", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY)).isEqualTo("2026-10-21");
		assertThat(next("FREQ=MONTHLY", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY)).isEqualTo("2026-11-14");
		assertThat(next("FREQ=WEEKLY;BYDAY=MO,FR", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY))
			.isEqualTo("2026-10-16");
	}

	@Test
	void anOverdueTaskSkipsTheOccurrencesAlreadyPast() {
		// Due three weeks ago on a Wednesday, completed on Thursday 2026-11-05: next Wednesday after that.
		assertThat(next("FREQ=WEEKLY", RecurrenceFrom.DUE, "2026-10-14", LocalDate.of(2026, 11, 5)))
			.isEqualTo("2026-11-11");
		// A daily task years overdue rolls to tomorrow, fast.
		assertThat(next("FREQ=DAILY", RecurrenceFrom.DUE, "2020-01-01", WEDNESDAY)).isEqualTo("2026-10-15");
	}

	@Test
	void fromCompletionCountsFromTheCompletionDay() {
		assertThat(next("FREQ=DAILY;INTERVAL=3", RecurrenceFrom.COMPLETION, "2026-10-01", WEDNESDAY))
			.isEqualTo("2026-10-17");
		assertThat(next("FREQ=WEEKLY", RecurrenceFrom.COMPLETION, null, WEDNESDAY)).isEqualTo("2026-10-21");
		assertThat(next("FREQ=MONTHLY;BYMONTHDAY=1", RecurrenceFrom.COMPLETION, null, WEDNESDAY))
			.isEqualTo("2026-11-01");
	}

	@Test
	void timesAreKept() {
		assertThat(next("FREQ=DAILY", RecurrenceFrom.DUE, "2026-10-14T09:30", WEDNESDAY))
			.isEqualTo("2026-10-15T09:30");
		assertThat(next("FREQ=WEEKLY", RecurrenceFrom.COMPLETION, "2026-10-01T18:00", WEDNESDAY))
			.isEqualTo("2026-10-21T18:00");
		assertThat(next("FREQ=DAILY;BYHOUR=7;BYMINUTE=15", RecurrenceFrom.DUE, "2026-10-14T07:15", WEDNESDAY))
			.isEqualTo("2026-10-15T07:15");
		// An hour on an all-day task is ignored.
		assertThat(next("FREQ=DAILY;BYHOUR=7", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY)).isEqualTo("2026-10-15");
	}

	@Test
	void theMonthEndFollowsTheRule() {
		// RFC 5545: a month without a 31st has no occurrence.
		assertThat(next("FREQ=MONTHLY", RecurrenceFrom.DUE, "2026-01-31", LocalDate.of(2026, 1, 31)))
			.isEqualTo("2026-03-31");
		assertThat(next("FREQ=MONTHLY;BYMONTHDAY=-1", RecurrenceFrom.DUE, "2026-01-31", LocalDate.of(2026, 1, 31)))
			.isEqualTo("2026-02-28");
	}

	@Test
	void countIsTheNumberOfOccurrencesLeft() {
		Recurrence.Next next = Recurrence.next("FREQ=DAILY;COUNT=3", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY);
		assertThat(next).isNotNull();
		assertThat(next.value()).isEqualTo("2026-10-15");
		assertThat(next.rrule()).isEqualTo("FREQ=DAILY;COUNT=2");
		next = Recurrence.next(next.rrule(), RecurrenceFrom.DUE, next.value(), LocalDate.of(2026, 10, 15));
		assertThat(next.rrule()).isEqualTo("FREQ=DAILY;COUNT=1");
		assertThat(Recurrence.next(next.rrule(), RecurrenceFrom.DUE, next.value(), LocalDate.of(2026, 10, 16)))
			.isNull();
	}

	@Test
	void untilEndsTheSeries() {
		assertThat(next("FREQ=WEEKLY;UNTIL=20261025", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY))
			.isEqualTo("2026-10-21");
		assertThat(Recurrence.next("FREQ=WEEKLY;UNTIL=20261020", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY))
			.isNull();
		assertThat(Recurrence.next("FREQ=WEEKLY;UNTIL=20261028T235959Z", RecurrenceFrom.DUE, "2026-10-21",
				WEDNESDAY)).isNotNull();
	}

	@Test
	void aRuleThatCannotBeEvaluatedHasNoNextOccurrence() {
		assertThat(Recurrence.next("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", RecurrenceFrom.DUE, "2026-10-14",
				WEDNESDAY)).isNull();
		assertThat(Recurrence.next("NONSENSE", RecurrenceFrom.DUE, "2026-10-14", WEDNESDAY)).isNull();
	}

	private static String next(String rule, RecurrenceFrom from, String anchor, LocalDate day) {
		Recurrence.Next next = Recurrence.next(rule, from, anchor, day);
		assertThat(next).as(rule).isNotNull();
		return next.value();
	}

}
