package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.TextRange;
import org.jspecify.annotations.Nullable;

/**
 * The line-based scanner of DESIGN §5.5.2 to §5.5.5. Input is the decoded text with any BOM already stripped; every
 * offset is a UTF-16 index into it. Lines split on {@code \n}; a trailing {@code \r} is ignored for matching but still
 * counts in offsets.
 * <p>
 * Excluded zones (no links or tags): frontmatter, fenced code, {@code $$} math, inline code spans closed on the same
 * line, {@code %% %%} and {@code <!-- -->} comments. Indented code blocks are deliberately not excluded, because
 * Obsidian list continuations are often indented.
 */
public final class MarkdownScanner {

	private static final Pattern ATX = Pattern.compile("^ {0,3}(#{1,6})(?=[ \\t]|$)(.*)$");

	private static final Pattern ATX_CLOSING = Pattern.compile("(?:^|[ \\t]+)#+$");

	private static final Pattern SETEXT_UNDERLINE = Pattern.compile("^ {0,3}(=+|-+)[ \\t]*$");

	private static final Pattern LIST_OR_QUOTE = Pattern
		.compile("^ {0,3}(?:[-+*][ \\t]|[-+*]$|\\d{1,9}[.)](?:[ \\t]|$)|>)");

	private static final Pattern THEMATIC_BREAK = Pattern
		.compile("^ {0,3}(?:(?:\\*[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:-[ \\t]*){3,})$");

	private static final Pattern BLOCK_ID = Pattern.compile("(?:^|\\s)\\^([A-Za-z0-9-]+)\\s*$");

	private MarkdownScanner() {
	}

	private enum Zone {

		NONE(""), PERCENT("%%"), HTML("-->"), MATH("$$");

		final String closer;

		Zone(String closer) {
			this.closer = closer;
		}

	}

	public static NoteParse scan(String text, boolean hadBom, boolean lossy) {
		int[] lineStarts = lineStarts(text);
		int lineCount = lineStarts.length;
		List<TextRange> excluded = new ArrayList<>();

		Frontmatter frontmatter = null;
		String frontmatterError = null;
		List<String> aliases = List.of();
		List<TagOcc> tags = new ArrayList<>();
		List<LinkOcc> links = new ArrayList<>();
		int bodyStart = 0;
		if (isDashLine(text, lineStarts, 0)) {
			int closing = -1;
			for (int j = 1; j < lineCount; j++) {
				if (isDashLine(text, lineStarts, j)) {
					closing = j;
					break;
				}
			}
			if (closing > 0) {
				int end = (closing + 1 < lineCount) ? lineStarts[closing + 1] : text.length();
				FrontmatterParser.Result result = FrontmatterParser.parse(text, lineStarts, 1, closing);
				frontmatter = new Frontmatter(result.data(), 0, end, closing);
				frontmatterError = result.error();
				aliases = result.aliases();
				tags.addAll(result.tags());
				links.addAll(result.links());
				excluded.add(new TextRange(0, end));
				bodyStart = closing + 1;
			}
		}

		boolean[] codeLine = new boolean[lineCount];
		findExcludedZones(text, lineStarts, bodyStart, excluded, codeLine);
		Excluded zones = new Excluded(excluded);

		List<HeadingOcc> headings = new ArrayList<>();
		List<String> blockIds = new ArrayList<>();
		List<TextRange> allLinkSpans = new ArrayList<>();
		for (int i = bodyStart; i < lineCount; i++) {
			if (codeLine[i]) {
				continue;
			}
			int ls = lineStarts[i];
			int le = contentEnd(text, lineStarts, i);
			String line = text.substring(ls, le);
			scanHeading(text, lineStarts, i, line, bodyStart, codeLine, zones, headings);
			List<int[]> linkSpans = new ArrayList<>();
			scanWikilinks(text, i, ls, le, zones, links, linkSpans);
			scanMarkdownLinks(text, i, ls, le, zones, links, linkSpans);
			linkSpans.forEach((span) -> allLinkSpans.add(new TextRange(span[0], span[1])));
			scanTags(text, i, ls, le, zones, linkSpans, tags);
			Matcher blockId = BLOCK_ID.matcher(line);
			if (blockId.find() && !zones.overlaps(ls + blockId.start(1) - 1, ls + blockId.end(1))) {
				blockIds.add(blockId.group(1));
			}
		}
		links.sort((a, b) -> Integer.compare(a.from(), b.from()));
		return new NoteParse(frontmatter, frontmatterError, aliases, List.copyOf(tags), List.copyOf(headings),
				List.copyOf(links), List.copyOf(blockIds), lineStarts, List.copyOf(excluded), List.copyOf(allLinkSpans),
				hadBom, lossy);
	}

	static int[] lineStarts(String text) {
		int count = 1;
		for (int i = 0; i < text.length(); i++) {
			if (text.charAt(i) == '\n') {
				count++;
			}
		}
		int[] starts = new int[count];
		int line = 1;
		for (int i = 0; i < text.length(); i++) {
			if (text.charAt(i) == '\n') {
				starts[line++] = i + 1;
			}
		}
		return starts;
	}

	/** The end of line {@code i}'s content, before {@code \n} and a {@code \r} preceding it. */
	static int contentEnd(String text, int[] lineStarts, int i) {
		int end = (i + 1 < lineStarts.length) ? lineStarts[i + 1] - 1 : text.length();
		if (end > lineStarts[i] && text.charAt(end - 1) == '\r') {
			end--;
		}
		return end;
	}

	private static boolean isDashLine(String text, int[] lineStarts, int i) {
		if (i >= lineStarts.length) {
			return false;
		}
		return text.substring(lineStarts[i], contentEnd(text, lineStarts, i)).stripTrailing().equals("---");
	}

	private static void findExcludedZones(String text, int[] lineStarts, int bodyStart, List<TextRange> excluded,
			boolean[] codeLine) {
		Zone zone = Zone.NONE;
		int zoneStart = -1;
		Fence fence = null;
		int fenceStart = -1;
		for (int i = bodyStart; i < lineStarts.length; i++) {
			int ls = lineStarts[i];
			int le = contentEnd(text, lineStarts, i);
			int next = (i + 1 < lineStarts.length) ? lineStarts[i + 1] : text.length();
			String line = text.substring(ls, le);
			if (fence != null) {
				codeLine[i] = true;
				if (fence.closedBy(line)) {
					excluded.add(new TextRange(fenceStart, next));
					fence = null;
				}
				continue;
			}
			if (zone == Zone.NONE) {
				Fence open = Fence.openedBy(line);
				if (open != null) {
					fence = open;
					fenceStart = ls;
					codeLine[i] = true;
					continue;
				}
			}
			int p = 0;
			while (p < line.length()) {
				if (zone != Zone.NONE) {
					int close = line.indexOf(zone.closer, p);
					if (close < 0) {
						break;
					}
					excluded.add(new TextRange(zoneStart, ls + close + zone.closer.length()));
					p = close + zone.closer.length();
					zone = Zone.NONE;
					continue;
				}
				char c = line.charAt(p);
				if (c == '`') {
					int run = runLength(line, p, '`');
					int close = closingRun(line, p + run, run);
					if (close >= 0) {
						excluded.add(new TextRange(ls + p, ls + close + run));
						p = close + run;
					}
					else {
						p += run;
					}
				}
				else if (line.startsWith("%%", p)) {
					zone = Zone.PERCENT;
					zoneStart = ls + p;
					p += 2;
				}
				else if (line.startsWith("<!--", p)) {
					zone = Zone.HTML;
					zoneStart = ls + p;
					p += 4;
				}
				else if (line.startsWith("$$", p) && text.indexOf("$$", ls + p + 2) >= 0) {
					zone = Zone.MATH;
					zoneStart = ls + p;
					p += 2;
				}
				else {
					p++;
				}
			}
		}
		if (fence != null) {
			excluded.add(new TextRange(fenceStart, text.length()));
		}
		if (zone != Zone.NONE) {
			excluded.add(new TextRange(zoneStart, text.length()));
		}
	}

	private static void scanHeading(String text, int[] lineStarts, int i, String line, int bodyStart,
			boolean[] codeLine, Excluded zones, List<HeadingOcc> headings) {
		int ls = lineStarts[i];
		Matcher atx = ATX.matcher(line);
		if (atx.matches()) {
			if (!zones.contains(ls + atx.start(1))) {
				String content = atx.group(2).strip();
				content = ATX_CLOSING.matcher(content).replaceFirst("").strip();
				headings.add(new HeadingOcc(atx.group(1).length(), content, i));
			}
			return;
		}
		Matcher underline = SETEXT_UNDERLINE.matcher(line);
		if (!underline.matches() || zones.contains(ls + underline.start(1))) {
			return;
		}
		int start = i;
		while (start - 1 >= bodyStart && isParagraphLine(text, lineStarts, start - 1, codeLine, zones)) {
			start--;
		}
		if (start == i) {
			return;
		}
		StringBuilder content = new StringBuilder();
		for (int k = start; k < i; k++) {
			if (!content.isEmpty()) {
				content.append(' ');
			}
			content.append(text.substring(lineStarts[k], contentEnd(text, lineStarts, k)).strip());
		}
		int level = underline.group(1).charAt(0) == '=' ? 1 : 2;
		headings.add(new HeadingOcc(level, content.toString(), start));
	}

	private static boolean isParagraphLine(String text, int[] lineStarts, int k, boolean[] codeLine, Excluded zones) {
		if (codeLine[k]) {
			return false;
		}
		int ls = lineStarts[k];
		int le = contentEnd(text, lineStarts, k);
		String line = text.substring(ls, le);
		if (line.isBlank() || zones.contains(ls)) {
			return false;
		}
		return !ATX.matcher(line).matches() && !LIST_OR_QUOTE.matcher(line).find()
				&& !SETEXT_UNDERLINE.matcher(line).matches() && !THEMATIC_BREAK.matcher(line).matches();
	}

	private static void scanWikilinks(String text, int line, int ls, int le, Excluded zones, List<LinkOcc> links,
			List<int[]> spans) {
		Matcher m = Syntax.WIKILINK.matcher(text).region(ls, le);
		while (m.find()) {
			if (zones.overlaps(m.start(), m.end())) {
				continue;
			}
			spans.add(new int[] { m.start(), m.end() });
			boolean embed = !m.group(1).isEmpty();
			int bodyStart = m.start(2);
			Syntax.WikiBody body = Syntax.parseWikiBody(m.group(2));
			links.add(new LinkOcc(m.group(), body.target(), body.subpath(), body.display(), embed, LinkStyle.WIKI,
					false, line, m.start(), m.end(), bodyStart + body.targetStart(), bodyStart + body.targetEnd(),
					false, true, LinkOcc.Quoting.BODY));
		}
	}

	private static void scanMarkdownLinks(String text, int line, int ls, int le, Excluded zones, List<LinkOcc> links,
			List<int[]> spans) {
		Matcher m = Syntax.MARKDOWN_LINK.matcher(text).region(ls, le);
		while (m.find()) {
			if (zones.overlaps(m.start(), m.end()) || overlapsAny(spans, m.start(), m.end())) {
				continue;
			}
			spans.add(new int[] { m.start(), m.end() });
			String destination = m.group(3);
			boolean angle = destination.startsWith("<");
			String inner = angle ? destination.substring(1, destination.length() - 1) : destination;
			if (!Syntax.isInternalDestination(inner)) {
				continue;
			}
			int innerStart = m.start(3) + (angle ? 1 : 0);
			int hash = inner.indexOf('#');
			String targetRaw = hash >= 0 ? inner.substring(0, hash) : inner;
			String subpathRaw = hash >= 0 ? inner.substring(hash + 1) : null;
			String target = Syntax.trim(angle ? targetRaw : Syntax.percentDecode(targetRaw));
			String subpath = (subpathRaw == null || angle) ? subpathRaw : Syntax.percentDecode(subpathRaw);
			links.add(new LinkOcc(m.group(), target, subpath, m.group(2), !m.group(1).isEmpty(), LinkStyle.MARKDOWN,
					angle, line, m.start(), m.end(), innerStart, innerStart + targetRaw.length(), false, true,
					LinkOcc.Quoting.BODY));
		}
	}

	private static void scanTags(String text, int line, int ls, int le, Excluded zones, List<int[]> linkSpans,
			List<TagOcc> tags) {
		Matcher m = Syntax.TAG.matcher(text).region(ls, le);
		while (m.find()) {
			if (zones.overlaps(m.start(), m.end()) || overlapsAny(linkSpans, m.start(), m.end())) {
				continue;
			}
			String tag = Syntax.normalizeTag(m.group(1));
			if (tag != null) {
				tags.add(new TagOcc(tag, line, m.start(), m.start() + 1 + tag.length(), false));
			}
		}
	}

	private static boolean overlapsAny(List<int[]> spans, int from, int to) {
		for (int[] span : spans) {
			if (from < span[1] && span[0] < to) {
				return true;
			}
		}
		return false;
	}

	private static int runLength(String line, int from, char c) {
		int end = from;
		while (end < line.length() && line.charAt(end) == c) {
			end++;
		}
		return end - from;
	}

	/** The start of the next backtick run of exactly {@code length} at or after {@code from}, or -1. */
	private static int closingRun(String line, int from, int length) {
		int q = from;
		while (q < line.length()) {
			if (line.charAt(q) == '`') {
				int run = runLength(line, q, '`');
				if (run == length) {
					return q;
				}
				q += run;
			}
			else {
				q++;
			}
		}
		return -1;
	}

	/** A fenced code block opener: up to 3 spaces, then 3 or more backticks or tildes. */
	private record Fence(char marker, int length) {

		static @Nullable Fence openedBy(String line) {
			int indent = 0;
			while (indent < line.length() && indent < 4 && line.charAt(indent) == ' ') {
				indent++;
			}
			if (indent > 3 || indent >= line.length()) {
				return null;
			}
			char c = line.charAt(indent);
			if (c != '`' && c != '~') {
				return null;
			}
			int run = runLength(line, indent, c);
			if (run < 3) {
				return null;
			}
			if (c == '`' && line.indexOf('`', indent + run) >= 0) {
				return null;
			}
			return new Fence(c, run);
		}

		boolean closedBy(String line) {
			int indent = 0;
			while (indent < line.length() && indent < 4 && line.charAt(indent) == ' ') {
				indent++;
			}
			if (indent > 3) {
				return false;
			}
			int run = runLength(line, indent, this.marker);
			return run >= this.length && line.substring(indent + run).isBlank();
		}

	}

	/** Sorted, disjoint excluded ranges with logarithmic overlap queries. */
	private static final class Excluded {

		private final int[] starts;

		private final int[] ends;

		Excluded(List<TextRange> ranges) {
			List<TextRange> sorted = new ArrayList<>(ranges);
			sorted.sort((a, b) -> Integer.compare(a.from(), b.from()));
			this.starts = new int[sorted.size()];
			this.ends = new int[sorted.size()];
			for (int i = 0; i < sorted.size(); i++) {
				this.starts[i] = sorted.get(i).from();
				this.ends[i] = sorted.get(i).to();
			}
		}

		boolean overlaps(int from, int to) {
			int lo = 0;
			int hi = this.starts.length - 1;
			int candidate = -1;
			while (lo <= hi) {
				int mid = (lo + hi) >>> 1;
				if (this.starts[mid] < to) {
					candidate = mid;
					lo = mid + 1;
				}
				else {
					hi = mid - 1;
				}
			}
			return candidate >= 0 && this.ends[candidate] > from;
		}

		boolean contains(int offset) {
			return overlaps(offset, offset + 1);
		}

	}

}
