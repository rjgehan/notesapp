package com.rjgehan.notes.publish;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * The HTML document around a published note's body, and the one stylesheet every published page links (DESIGN
 * §5.26). The page loads nothing but that stylesheet and the snapshot's own attachments, and runs no script.
 */
public final class PublishPage {

	/** Where the stylesheet is served; {@code -} is never a slug. */
	public static final String STYLESHEET_PATH = "/p/-/style.css";

	private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("d MMMM uuuu", Locale.ENGLISH)
		.withZone(ZoneOffset.UTC);

	public static final String STYLESHEET = """
			:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de;
			  --accent: #0969da; --code-bg: #f3f4f6; --quote: #57606a; }
			@media (prefers-color-scheme: dark) {
			  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --border: #30363d; --accent: #4493f8;
			    --code-bg: #161b22; --quote: #9198a1; }
			}
			* { box-sizing: border-box; }
			html { -webkit-text-size-adjust: 100%; }
			body { margin: 0; background: var(--bg); color: var(--fg);
			  font: 17px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
			main { max-width: 720px; margin: 0 auto; padding: 32px 16px 48px; }
			h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; }
			main > h1:first-child { margin-top: 0; }
			a { color: var(--accent); }
			img, video { max-width: 100%; height: auto; }
			audio { width: 100%; }
			pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
			code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 4px; }
			pre { background: var(--code-bg); padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
			pre code { background: none; padding: 0; }
			blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid var(--border); color: var(--quote); }
			table { border-collapse: collapse; display: block; overflow-x: auto; }
			th, td { border: 1px solid var(--border); padding: 6px 12px; }
			hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
			li > input[type=checkbox] { margin-right: 0.4em; }
			.footnotes { font-size: 0.9em; color: var(--muted); }
			footer { max-width: 720px; margin: 0 auto; padding: 0 16px 32px; color: var(--muted); font-size: 0.85em; }
			""";

	private PublishPage() {
	}

	/** The whole document; {@code body} is trusted output of {@link PublishRenderer}, {@code title} plain text. */
	public static String document(String title, String body, Instant publishedAt) {
		String safeTitle = escapeHtml(title);
		return "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
				+ "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
				+ "<meta name=\"robots\" content=\"noindex, nofollow\">\n"
				+ "<meta name=\"referrer\" content=\"no-referrer\">\n"
				+ "<title>" + safeTitle + "</title>\n"
				+ "<link rel=\"stylesheet\" href=\"" + STYLESHEET_PATH + "\">\n"
				+ "</head>\n<body>\n<main>\n<h1>" + safeTitle + "</h1>\n" + body + "</main>\n"
				+ "<footer>Published " + DATE.format(publishedAt) + "</footer>\n</body>\n</html>\n";
	}

	static String escapeHtml(String text) {
		StringBuilder out = new StringBuilder(text.length() + 16);
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			switch (c) {
				case '&' -> out.append("&amp;");
				case '<' -> out.append("&lt;");
				case '>' -> out.append("&gt;");
				case '"' -> out.append("&quot;");
				case '\'' -> out.append("&#39;");
				default -> out.append(c);
			}
		}
		return out.toString();
	}

}
