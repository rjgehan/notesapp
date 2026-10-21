package com.rjgehan.notes.capture;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

/** The moment.js token table of DESIGN §6.12 (Fri 2026-10-16 14:03:09, locale en), as dayjs renders it. */
class MomentFormatTest {

	private static final ZonedDateTime FRIDAY = ZonedDateTime.of(LocalDateTime.of(2026, 10, 16, 14, 3, 9, 120_000_000),
			ZoneId.of("America/New_York"));

	@ParameterizedTest
	@CsvSource(delimiter = '|', quoteCharacter = '"', textBlock = """
			YYYY-MM-DD                      | 2026-10-16
			YY                              | 26
			Q                               | 4
			M MM MMM MMMM                   | 10 10 Oct October
			D DD Do                         | 16 16 16th
			d dd ddd dddd                   | 5 Fr Fri Friday
			w ww wo                         | 42 42 42nd
			W WW                            | 42 42
			gggg GGGG                       | 2026 2026
			H HH h hh                       | 14 14 2 02
			k kk                            | 14 14
			m mm s ss SSS                   | 3 03 9 09 120
			A a                             | PM pm
			Z ZZ                            | -04:00 -0400
			LT                              | 2:03 PM
			LTS                             | 2:03:09 PM
			L                               | 10/16/2026
			LL                              | "October 16, 2026"
			LLL                             | "October 16, 2026 2:03 PM"
			LLLL                            | "Friday, October 16, 2026 2:03 PM"
			l ll                            | "10/16/2026 Oct 16, 2026"
			[Week] W [of] YYYY              | Week 42 of 2026
			YYYY/MM-MMMM/YYYY-MM-DD dddd    | 2026/10-October/2026-10-16 Friday
			YYYY-[W]WW                      | 2026-W42
			HH:mm                           | 14:03
			""")
	void formatsLikeDayjs(String format, String expected) {
		assertThat(MomentFormat.format(format, FRIDAY)).isEqualTo(expected);
	}

	@ParameterizedTest
	@CsvSource(delimiter = '|', textBlock = """
			2026-01-01T00:30 | k h A Do d | 24 12 AM 1st 4
			2026-01-02T12:00 | h A Do     | 12 PM 2nd
			2026-01-03T09:05 | Do w gggg  | 3rd 1 2026
			2026-12-31T23:59 | W GGGG w gggg | 53 2026 1 2027
			2021-01-03T10:00 | W GGGG     | 53 2020
			2026-03-11T10:00 | Do         | 11th
			2026-03-22T10:00 | Do         | 22nd
			""")
	void edgesOfDaysAndWeeks(String time, String format, String expected) {
		ZonedDateTime t = LocalDateTime.parse(time).atZone(ZoneId.of("UTC"));
		assertThat(MomentFormat.format(format, t)).isEqualTo(expected);
	}

	@ParameterizedTest
	@CsvSource(delimiter = '|', textBlock = """
			X | 1792173789
			x | 1792173789120
			""")
	void unixTimes(String format, String expected) {
		assertThat(MomentFormat.format(format, FRIDAY)).isEqualTo(expected);
	}

}
