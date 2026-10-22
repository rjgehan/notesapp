package com.rjgehan.notes.capture;

import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.settings.TemplatesSettings;
import org.jspecify.annotations.Nullable;

/**
 * The text a capture appends (API.md §8.5): one list item, {@code - <stamp> <text>}, with any further lines indented
 * under it, a link for a shared URL and an embed for a captured file. Also renders a daily-note template for a
 * capture that creates the note, with the placeholder grammar of DESIGN §5.11.
 */
public final class CaptureText {

	/**
	 * The placeholders of DESIGN §5.11: {@code title}, {@code date} and {@code time} with an optional format, then
	 * {@code cursor} and {@code prompt:Question|default} (ROADMAP item 30).
	 */
	private static final Pattern PLACEHOLDER = Pattern.compile(
			"\\{\\{\\s*(?:(title|date|time)(?::([^}]*))?|(cursor)|prompt:([^}|]*)(?:\\|([^}]*))?)\\s*\\}\\}",
			Pattern.CASE_INSENSITIVE);

	private CaptureText() {
	}

	/**
	 * The entry, ending with a line break (LF). {@code text} may span lines; {@code url} becomes a link (titled when
	 * {@code title} is given) unless the text already contains it; {@code embed} goes on its own line.
	 * @return null when there is nothing to capture
	 */
	public static @Nullable String entry(String stamp, @Nullable String text, @Nullable String url,
			@Nullable String title, @Nullable String embed) {
		String body = (text == null) ? "" : text.replace("\r\n", "\n").replace('\r', '\n').strip();
		String link = link(url, title, body);
		if (link != null) {
			body = body.isEmpty() ? link : body + (body.contains("\n") ? "\n" : " ") + link;
		}
		if (embed != null && !embed.isBlank()) {
			body = body.isEmpty() ? embed.strip() : body + "\n" + embed.strip();
		}
		if (body.isEmpty()) {
			return null;
		}
		List<String> lines = new ArrayList<>(List.of(body.split("\n", -1)));
		StringBuilder out = new StringBuilder("- ").append(stamp).append(' ').append(lines.remove(0).stripTrailing());
		for (String line : lines) {
			out.append('\n');
			if (!line.isBlank()) {
				out.append("  ").append(line.stripTrailing());
			}
		}
		return out.append('\n').toString();
	}

	/** A Markdown link for a shared URL, or null when there is none or the text already has it. */
	static @Nullable String link(@Nullable String url, @Nullable String title, String text) {
		if (url == null || url.isBlank()) {
			return null;
		}
		String u = url.strip();
		if (text.contains(u)) {
			return null;
		}
		String scheme = u.toLowerCase(Locale.ROOT);
		if (!scheme.startsWith("http://") && !scheme.startsWith("https://")) {
			// Not a web link (a note title, an app's own scheme): kept as plain text.
			return u;
		}
		String destination = u.replace(" ", "%20")
			.replace("(", "%28")
			.replace(")", "%29")
			.replace("<", "%3C")
			.replace(">", "%3E");
		String label = (title == null) ? "" : title.strip().replaceAll("\\s+", " ");
		if (label.isEmpty() || label.equals(u)) {
			return "<" + destination + ">";
		}
		return "[" + label.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]") + "](" + destination + ")";
	}

	/**
	 * Renders {@code {{title}}}, {@code {{date}}}, {@code {{time}}} and their {@code :FORMAT} forms (DESIGN §5.11).
	 * Nobody is there to answer: {@code {{prompt:Question|default}}} renders its default (or nothing) and
	 * {@code {{cursor}}} is removed.
	 */
	public static String renderTemplate(String template, String title, ZonedDateTime now, TemplatesSettings settings) {
		Matcher m = PLACEHOLDER.matcher(template);
		StringBuilder out = new StringBuilder();
		while (m.find()) {
			String value;
			if (m.group(3) != null) {
				value = "";
			}
			else if (m.group(4) != null) {
				// An empty question is not a prompt: it stays as written, like any unknown placeholder.
				value = m.group(4).isBlank() ? m.group() : (m.group(5) != null) ? m.group(5).strip() : "";
			}
			else if (m.group(1).toLowerCase(Locale.ROOT).equals("title")) {
				value = title;
			}
			else {
				String format = (m.group(2) != null) ? m.group(2)
						: m.group(1).equalsIgnoreCase("date") ? settings.dateFormat() : settings.timeFormat();
				value = MomentFormat.format(format, now);
			}
			m.appendReplacement(out, Matcher.quoteReplacement(value));
		}
		m.appendTail(out);
		return out.toString();
	}

}
