package com.rjgehan.notes.properties;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

import com.rjgehan.notes.index.Frontmatter;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.NoteParse;
import org.jspecify.annotations.Nullable;
import org.snakeyaml.engine.v2.api.LoadSettings;
import org.snakeyaml.engine.v2.api.lowlevel.Compose;
import org.snakeyaml.engine.v2.common.FlowStyle;
import org.snakeyaml.engine.v2.common.ScalarStyle;
import org.snakeyaml.engine.v2.exceptions.Mark;
import org.snakeyaml.engine.v2.nodes.MappingNode;
import org.snakeyaml.engine.v2.nodes.Node;
import org.snakeyaml.engine.v2.nodes.NodeTuple;
import org.snakeyaml.engine.v2.nodes.ScalarNode;
import org.snakeyaml.engine.v2.schema.CoreSchema;

/**
 * Renames a top-level frontmatter property in a note's text (ROADMAP item 13, DESIGN §5.38) without re-serializing
 * anything: only the key's own characters are replaced, so every other byte of the note (values, comments, quoting,
 * line endings) stays as it was. Names compare case-insensitively, as Obsidian's do. The result is parsed again and
 * must hold exactly the old properties under the new name, in the same order; anything else is reported as not
 * rewritable and the note is left alone.
 */
public final class FrontmatterKeys {

	/** A key written without quotes: it starts with a letter or {@code _} and reads back as itself. */
	private static final Pattern PLAIN_KEY = Pattern.compile("[\\p{L}_][\\p{L}\\p{N}_ .\\-/]*");

	private static final Pattern RESERVED = Pattern.compile("(?i)true|false|null|yes|no|on|off|y|n");

	private static final int CODE_POINT_LIMIT = 256 * 1024;

	private FrontmatterKeys() {
	}

	public enum Status {

		/** The property was renamed; {@code text} is the new text. */
		RENAMED,

		/** The note has no such property (or no readable frontmatter). */
		ABSENT,

		/** The note already has a property with the new name. */
		CONFLICT,

		/** The key cannot be renamed by replacing its characters (a flow mapping, a complex key, an alias). */
		NOT_REWRITABLE

	}

	public record Result(Status status, @Nullable String text) {

		static Result of(Status status) {
			return new Result(status, null);
		}

	}

	/** The frontmatter properties of a text, or null when it has none that parse as a mapping. */
	public static @Nullable Map<String, @Nullable Object> properties(String text) {
		Frontmatter frontmatter = MarkdownScanner.scan(text, false, false).frontmatter();
		return (frontmatter != null) ? frontmatter.data() : null;
	}

	/** Whether {@code a} and {@code b} name the same property. */
	public static boolean sameName(String a, String b) {
		return a.toLowerCase(Locale.ROOT).equals(b.toLowerCase(Locale.ROOT));
	}

	/** Renames the property {@code from} (any case) to {@code to} in {@code text}. */
	public static Result rename(String text, String from, String to) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		Frontmatter frontmatter = parse.frontmatter();
		if (frontmatter == null || frontmatter.data() == null) {
			return Result.of(Status.ABSENT);
		}
		Map<String, @Nullable Object> data = frontmatter.data();
		boolean present = false;
		for (String key : data.keySet()) {
			if (sameName(key, from)) {
				present = true;
			}
			else if (sameName(key, to)) {
				return Result.of(Status.CONFLICT);
			}
		}
		if (!present) {
			return Result.of(Status.ABSENT);
		}
		int[] lineStarts = parse.lineStarts();
		int yamlStart = lineStarts[1];
		int yamlEnd = lineStarts[frontmatter.closingLine()];
		String yaml = text.substring(yamlStart, yamlEnd);
		List<int[]> spans = keySpans(yaml, from);
		if (spans == null || spans.isEmpty()) {
			return Result.of(Status.NOT_REWRITABLE);
		}
		Map<String, @Nullable Object> expected = new LinkedHashMap<>();
		data.forEach((key, value) -> expected.put(sameName(key, from) ? to : key, value));
		List<String> candidates = new ArrayList<>();
		if (PLAIN_KEY.matcher(to).matches() && !RESERVED.matcher(to).matches() && !to.endsWith(" ")) {
			candidates.add(to);
		}
		candidates.add(doubleQuoted(to));
		for (String written : candidates) {
			StringBuilder out = new StringBuilder(yaml);
			for (int i = spans.size() - 1; i >= 0; i--) {
				out.replace(spans.get(i)[0], spans.get(i)[1], written);
			}
			String next = text.substring(0, yamlStart) + out + text.substring(yamlEnd);
			Map<String, @Nullable Object> after = properties(next);
			if (after != null && sameEntries(after, expected)) {
				return new Result(Status.RENAMED, next);
			}
		}
		return Result.of(Status.NOT_REWRITABLE);
	}

	/**
	 * Same keys with equal values. Order is not compared: replacing a key's characters cannot move it, but where a
	 * note repeats a key, the parser keeps the last value at a place of its choosing.
	 */
	private static boolean sameEntries(Map<String, @Nullable Object> a, Map<String, @Nullable Object> b) {
		return a.size() == b.size()
				&& a.keySet().stream().allMatch((key) -> b.containsKey(key) && Objects.equals(a.get(key), b.get(key)));
	}

	/**
	 * Where the keys named {@code name} are in the YAML ({@code [from, to)} UTF-16 offsets), or null when one of them
	 * cannot be replaced in place: the root must be a block mapping and each key a one-line scalar at column 0.
	 */
	private static @Nullable List<int[]> keySpans(String yaml, String name) {
		LoadSettings settings = LoadSettings.builder()
			.setSchema(new CoreSchema())
			.setAllowDuplicateKeys(true)
			.setMaxAliasesForCollections(20)
			.setCodePointLimit(CODE_POINT_LIMIT)
			.setUseMarks(true)
			.build();
		Optional<Node> root;
		try {
			root = new Compose(settings).composeString(yaml);
		}
		catch (RuntimeException | StackOverflowError ex) {
			return null;
		}
		if (!(root.orElse(null) instanceof MappingNode mapping) || mapping.getFlowStyle() == FlowStyle.FLOW) {
			return null;
		}
		int[] lineStarts = lineStarts(yaml);
		List<int[]> spans = new ArrayList<>();
		for (NodeTuple tuple : mapping.getValue()) {
			Node key = tuple.getKeyNode();
			if (!(key instanceof ScalarNode scalar) || !sameName(scalar.getValue(), name)) {
				continue;
			}
			ScalarStyle style = scalar.getScalarStyle();
			boolean simple = style == ScalarStyle.PLAIN || style == ScalarStyle.SINGLE_QUOTED
					|| style == ScalarStyle.DOUBLE_QUOTED;
			Mark start = scalar.getStartMark().orElse(null);
			Mark end = scalar.getEndMark().orElse(null);
			if (!simple || start == null || end == null || start.getLine() != end.getLine() || start.getColumn() != 0
					|| scalar.getAnchor().isPresent()) {
				return null;
			}
			int from = offset(yaml, lineStarts, start);
			int to = offset(yaml, lineStarts, end);
			// A key with an explicit tag or anchor has more before it than its text: not replaced in place.
			String source = yaml.substring(from, to);
			if (style == ScalarStyle.PLAIN ? !source.equals(scalar.getValue())
					: source.length() < 2 || source.charAt(0) != ((style == ScalarStyle.SINGLE_QUOTED) ? '\'' : '"')) {
				return null;
			}
			spans.add(new int[] { from, to });
		}
		return spans;
	}

	private static int[] lineStarts(String text) {
		List<Integer> starts = new ArrayList<>();
		starts.add(0);
		for (int i = 0; i < text.length(); i++) {
			if (text.charAt(i) == '\n') {
				starts.add(i + 1);
			}
		}
		return starts.stream().mapToInt(Integer::intValue).toArray();
	}

	/** A snakeyaml mark (line, code-point column) as a UTF-16 offset. */
	private static int offset(String text, int[] lineStarts, Mark mark) {
		int offset = lineStarts[Math.min(mark.getLine(), lineStarts.length - 1)];
		for (int column = mark.getColumn(); column > 0 && offset < text.length(); column--) {
			offset += Character.charCount(text.codePointAt(offset));
		}
		return offset;
	}

	/** A YAML double-quoted scalar: JSON's escapes are valid YAML. */
	static String doubleQuoted(String value) {
		StringBuilder out = new StringBuilder("\"");
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			switch (c) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				case '\t' -> out.append("\\t");
				default -> {
					if (c < 0x20 || c == 0x7f) {
						out.append(String.format("\\u%04x", (int) c));
					}
					else {
						out.append(c);
					}
				}
			}
		}
		return out.append('"').toString();
	}

}
