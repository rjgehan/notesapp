package com.rjgehan.notes.capture;

import java.time.ZonedDateTime;
import java.time.format.TextStyle;
import java.time.temporal.IsoFields;
import java.time.temporal.WeekFields;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Formats a time with moment.js tokens, as the browser does with dayjs (DESIGN §6.12), so a daily note created by a
 * capture (API.md §8.5) gets the same path as one created in the app. The token table and its java.time equivalents
 * are in DESIGN §6.12; locale {@code en}. Like dayjs, an unknown run of letters is output as is, and
 * {@code [text]} is literal.
 */
public final class MomentFormat {

	/** Longest tokens first, as dayjs (core, advancedFormat and localizedFormat) matches them. */
	private static final Pattern TOKEN = Pattern.compile("\\[([^\\]]*)]|LTS|LT|LLLL|LLL|LL|L|llll|lll|ll|l|Do|wo|YYYY|YY|Q"
			+ "|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|ww|w|WW|W|gggg|GGGG|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|A|a|X|x|ZZ|Z");

	private static final WeekFields US_WEEKS = WeekFields.of(Locale.US);

	private MomentFormat() {
	}

	public static String format(String format, ZonedDateTime t) {
		Matcher m = TOKEN.matcher(format);
		StringBuilder out = new StringBuilder();
		int last = 0;
		while (m.find()) {
			out.append(format, last, m.start());
			out.append((m.group(1) != null) ? m.group(1) : token(m.group(), t));
			last = m.end();
		}
		out.append(format, last, format.length());
		return out.toString();
	}

	private static String token(String token, ZonedDateTime t) {
		return switch (token) {
			case "LT" -> format("h:mm A", t);
			case "LTS" -> format("h:mm:ss A", t);
			case "L" -> format("MM/DD/YYYY", t);
			case "LL" -> format("MMMM D, YYYY", t);
			case "LLL" -> format("MMMM D, YYYY h:mm A", t);
			case "LLLL" -> format("dddd, MMMM D, YYYY h:mm A", t);
			case "l" -> format("M/D/YYYY", t);
			case "ll" -> format("MMM D, YYYY", t);
			case "lll" -> format("MMM D, YYYY h:mm A", t);
			case "llll" -> format("ddd, MMM D, YYYY h:mm A", t);
			case "YYYY" -> pad(t.getYear(), 4);
			case "YY" -> pad(Math.floorMod(t.getYear(), 100), 2);
			case "Q" -> String.valueOf(t.get(IsoFields.QUARTER_OF_YEAR));
			case "M" -> String.valueOf(t.getMonthValue());
			case "MM" -> pad(t.getMonthValue(), 2);
			case "MMM" -> t.getMonth().getDisplayName(TextStyle.SHORT, Locale.ENGLISH);
			case "MMMM" -> t.getMonth().getDisplayName(TextStyle.FULL, Locale.ENGLISH);
			case "D" -> String.valueOf(t.getDayOfMonth());
			case "DD" -> pad(t.getDayOfMonth(), 2);
			case "Do" -> ordinal(t.getDayOfMonth());
			case "d" -> String.valueOf(t.getDayOfWeek().getValue() % 7);
			case "dd" -> t.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.ENGLISH).substring(0, 2);
			case "ddd" -> t.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.ENGLISH);
			case "dddd" -> t.getDayOfWeek().getDisplayName(TextStyle.FULL, Locale.ENGLISH);
			case "w" -> String.valueOf(t.get(US_WEEKS.weekOfWeekBasedYear()));
			case "ww" -> pad(t.get(US_WEEKS.weekOfWeekBasedYear()), 2);
			case "wo" -> ordinal(t.get(US_WEEKS.weekOfWeekBasedYear()));
			case "W" -> String.valueOf(t.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR));
			case "WW" -> pad(t.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR), 2);
			case "gggg" -> pad(t.get(US_WEEKS.weekBasedYear()), 4);
			case "GGGG" -> pad(t.get(IsoFields.WEEK_BASED_YEAR), 4);
			case "H" -> String.valueOf(t.getHour());
			case "HH" -> pad(t.getHour(), 2);
			case "h" -> String.valueOf(hour12(t));
			case "hh" -> pad(hour12(t), 2);
			case "k" -> String.valueOf((t.getHour() == 0) ? 24 : t.getHour());
			case "kk" -> pad((t.getHour() == 0) ? 24 : t.getHour(), 2);
			case "m" -> String.valueOf(t.getMinute());
			case "mm" -> pad(t.getMinute(), 2);
			case "s" -> String.valueOf(t.getSecond());
			case "ss" -> pad(t.getSecond(), 2);
			case "SSS" -> pad(t.getNano() / 1_000_000, 3);
			case "A" -> (t.getHour() < 12) ? "AM" : "PM";
			case "a" -> (t.getHour() < 12) ? "am" : "pm";
			case "X" -> String.valueOf(t.toEpochSecond());
			case "x" -> String.valueOf(t.toInstant().toEpochMilli());
			case "Z" -> offset(t, true);
			case "ZZ" -> offset(t, false);
			default -> token;
		};
	}

	private static int hour12(ZonedDateTime t) {
		int h = t.getHour() % 12;
		return (h == 0) ? 12 : h;
	}

	private static String pad(int value, int width) {
		String s = String.valueOf(Math.abs(value));
		StringBuilder out = new StringBuilder((value < 0) ? "-" : "");
		for (int i = s.length(); i < width; i++) {
			out.append('0');
		}
		return out.append(s).toString();
	}

	/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st (dayjs's English ordinal). */
	static String ordinal(int n) {
		int mod100 = n % 100;
		String suffix = (mod100 >= 11 && mod100 <= 13) ? "th" : switch (n % 10) {
			case 1 -> "st";
			case 2 -> "nd";
			case 3 -> "rd";
			default -> "th";
		};
		return n + suffix;
	}

	private static String offset(ZonedDateTime t, boolean colon) {
		int seconds = t.getOffset().getTotalSeconds();
		int minutes = Math.abs(seconds) / 60;
		String sign = (seconds < 0) ? "-" : "+";
		return sign + pad(minutes / 60, 2) + (colon ? ":" : "") + pad(minutes % 60, 2);
	}

}
