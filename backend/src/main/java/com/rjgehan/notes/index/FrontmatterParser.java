package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.MatchResult;
import java.util.regex.Matcher;

import com.rjgehan.notes.api.dto.LinkStyle;
import org.jspecify.annotations.Nullable;
import org.snakeyaml.engine.v2.api.LoadSettings;
import org.snakeyaml.engine.v2.api.lowlevel.Compose;
import org.snakeyaml.engine.v2.constructor.StandardConstructor;
import org.snakeyaml.engine.v2.exceptions.Mark;
import org.snakeyaml.engine.v2.nodes.MappingNode;
import org.snakeyaml.engine.v2.nodes.Node;
import org.snakeyaml.engine.v2.nodes.NodeTuple;
import org.snakeyaml.engine.v2.nodes.ScalarNode;
import org.snakeyaml.engine.v2.nodes.SequenceNode;
import org.snakeyaml.engine.v2.nodes.Tag;
import org.snakeyaml.engine.v2.schema.CoreSchema;

/**
 * Parses frontmatter with snakeyaml-engine and the YAML 1.2 core schema (DESIGN §5.5.3), so dates and {@code yes}
 * stay strings. Parsing is lenient: a malformed block yields an error message and the note still indexes.
 */
public final class FrontmatterParser {

	private static final int CODE_POINT_LIMIT = 256 * 1024;

	private FrontmatterParser() {
	}

	public record Result(@Nullable Map<String, @Nullable Object> data, @Nullable String error, List<String> aliases,
			List<TagOcc> tags, List<LinkOcc> links) {
	}

	/**
	 * Parses the lines {@code firstLine .. closingLine - 1} of {@code text}. Link offsets are full-file offsets.
	 */
	public static Result parse(String text, int[] lineStarts, int firstLine, int closingLine) {
		String yaml = text.substring(lineStarts[firstLine], lineStarts[closingLine]);
		// A new settings object, composer and constructor per call: they are not thread-safe.
		LoadSettings settings = LoadSettings.builder()
			.setSchema(new CoreSchema())
			.setAllowDuplicateKeys(true)
			.setMaxAliasesForCollections(20)
			.setCodePointLimit(CODE_POINT_LIMIT)
			.setUseMarks(true)
			.build();
		Optional<Node> root;
		Object constructed;
		try {
			root = new Compose(settings).composeString(yaml);
			constructed = new StandardConstructor(settings).constructSingleDocument(root);
		}
		catch (RuntimeException | StackOverflowError ex) {
			String message = ex.getMessage();
			return new Result(null, message != null ? message : ex.getClass().getSimpleName(), List.of(), List.of(),
					List.of());
		}
		if (constructed == null) {
			return new Result(new LinkedHashMap<>(), null, List.of(), List.of(), List.of());
		}
		if (!(constructed instanceof Map<?, ?> map) || !(root.orElse(null) instanceof MappingNode mapping)) {
			return new Result(null, "Frontmatter is not a mapping", List.of(), List.of(), List.of());
		}
		Map<String, @Nullable Object> data = toJsonMap(map, new IdentityHashMap<>());
		Positions positions = new Positions(text, lineStarts, firstLine);
		List<TagOcc> tags = tags(data, mapping, positions);
		List<LinkOcc> links = new ArrayList<>();
		collectLinks(mapping, text, positions, links, Collections.newSetFromMap(new IdentityHashMap<>()));
		links.sort((a, b) -> Integer.compare(a.from(), b.from()));
		return new Result(data, null, aliases(data), tags, links);
	}

	private static List<String> aliases(Map<String, @Nullable Object> data) {
		List<String> aliases = new ArrayList<>();
		for (String key : List.of("aliases", "alias")) {
			for (String value : stringValues(data.get(key), false)) {
				String alias = Syntax.trim(value);
				if (!alias.isEmpty() && !aliases.contains(alias)) {
					aliases.add(alias);
				}
			}
		}
		return aliases;
	}

	private static List<TagOcc> tags(Map<String, @Nullable Object> data, MappingNode mapping, Positions positions) {
		List<TagOcc> tags = new ArrayList<>();
		for (String key : List.of("tags", "tag")) {
			Object value = data.get(key);
			if (value == null) {
				continue;
			}
			Node keyNode = lastKeyNode(mapping, key);
			int line = positions.firstLine;
			int from = positions.lineStarts[positions.firstLine];
			int to = from;
			if (keyNode != null && keyNode.getStartMark().isPresent() && keyNode.getEndMark().isPresent()) {
				from = positions.offset(keyNode.getStartMark().get());
				to = positions.offset(keyNode.getEndMark().get());
				line = positions.line(keyNode.getStartMark().get());
			}
			for (String raw : stringValues(value, true)) {
				String candidate = raw.startsWith("#") ? raw.substring(1) : raw;
				String tag = Syntax.normalizeTag(candidate);
				if (tag != null) {
					tags.add(new TagOcc(tag, line, from, to, true));
				}
			}
		}
		return tags;
	}

	/** Strings from a scalar or a list of scalars; with {@code splitTags}, string values split on commas and spaces. */
	private static List<String> stringValues(@Nullable Object value, boolean splitTags) {
		List<String> out = new ArrayList<>();
		if (value instanceof Collection<?> items) {
			for (Object item : items) {
				if (item != null && !(item instanceof Map<?, ?>) && !(item instanceof Collection<?>)) {
					out.add(String.valueOf(item));
				}
			}
		}
		else if (value instanceof String s && splitTags) {
			for (String part : s.split("[,\\s]+")) {
				if (!part.isEmpty()) {
					out.add(part);
				}
			}
		}
		else if (value != null && !(value instanceof Map<?, ?>)) {
			out.add(String.valueOf(value));
		}
		return out;
	}

	private static @Nullable Node lastKeyNode(MappingNode mapping, String key) {
		Node found = null;
		for (NodeTuple tuple : mapping.getValue()) {
			if (tuple.getKeyNode() instanceof ScalarNode scalar && key.equals(scalar.getValue())) {
				found = scalar;
			}
		}
		return found;
	}

	/**
	 * Finds {@code [[...]]} in every string value (keys excluded). A link is rewritable only when the scalar's source
	 * text contains exactly the same link text in the same order, so a splice maps 1:1 to the parsed value.
	 */
	private static void collectLinks(Node node, String text, Positions positions, List<LinkOcc> out, Set<Node> seen) {
		if (!seen.add(node)) {
			return;
		}
		if (node instanceof MappingNode mapping) {
			for (NodeTuple tuple : mapping.getValue()) {
				collectLinks(tuple.getValueNode(), text, positions, out, seen);
			}
		}
		else if (node instanceof SequenceNode sequence) {
			for (Node item : sequence.getValue()) {
				collectLinks(item, text, positions, out, seen);
			}
		}
		else if (node instanceof ScalarNode scalar && Tag.STR.equals(scalar.getTag())) {
			scalarLinks(scalar, text, positions, out);
		}
	}

	private static void scalarLinks(ScalarNode scalar, String text, Positions positions, List<LinkOcc> out) {
		String value = scalar.getValue();
		List<MatchResult> parsed = Syntax.WIKILINK.matcher(value).results().toList();
		if (parsed.isEmpty() || scalar.getStartMark().isEmpty() || scalar.getEndMark().isEmpty()) {
			return;
		}
		int spanFrom = positions.offset(scalar.getStartMark().get());
		int spanTo = Math.max(spanFrom, positions.offset(scalar.getEndMark().get()));
		List<int[]> source = new ArrayList<>();
		Matcher m = Syntax.WIKILINK.matcher(text).region(spanFrom, spanTo);
		while (m.find()) {
			source.add(new int[] { m.start(), m.end() });
		}
		boolean sameCount = source.size() == parsed.size();
		for (int i = 0; i < parsed.size(); i++) {
			MatchResult link = parsed.get(i);
			String raw = link.group();
			boolean embed = !link.group(1).isEmpty();
			Syntax.WikiBody body = Syntax.parseWikiBody(link.group(2));
			int from = spanFrom;
			int to = spanTo;
			boolean rewritable = false;
			int targetFrom = from;
			int targetTo = to;
			if (i < source.size()) {
				from = source.get(i)[0];
				to = source.get(i)[1];
				rewritable = sameCount && text.substring(from, to).equals(raw);
				if (rewritable) {
					int bodyStart = from + (embed ? 3 : 2);
					targetFrom = bodyStart + body.targetStart();
					targetTo = bodyStart + body.targetEnd();
				}
				else {
					targetFrom = from;
					targetTo = to;
				}
			}
			out.add(new LinkOcc(raw, body.target(), body.subpath(), body.display(), embed, LinkStyle.WIKI, false,
					positions.lineOf(from), from, to, targetFrom, targetTo, true, rewritable, quoting(scalar)));
		}
	}

	/** How a rewrite must write text inside this scalar (DESIGN §5.6: the YAML must keep its meaning). */
	private static LinkOcc.Quoting quoting(ScalarNode scalar) {
		return switch (scalar.getScalarStyle()) {
			case PLAIN -> LinkOcc.Quoting.PLAIN;
			case SINGLE_QUOTED -> LinkOcc.Quoting.SINGLE_QUOTED;
			case DOUBLE_QUOTED, JSON_SCALAR_STYLE -> LinkOcc.Quoting.DOUBLE_QUOTED;
			case LITERAL, FOLDED -> LinkOcc.Quoting.BLOCK;
		};
	}

	private static Map<String, @Nullable Object> toJsonMap(Map<?, ?> map, IdentityHashMap<Object, Boolean> path) {
		Map<String, @Nullable Object> out = new LinkedHashMap<>();
		if (path.put(map, Boolean.TRUE) != null) {
			return out;
		}
		for (Map.Entry<?, ?> entry : map.entrySet()) {
			out.put(String.valueOf(entry.getKey()), toJson(entry.getValue(), path));
		}
		path.remove(map);
		return out;
	}

	private static @Nullable Object toJson(@Nullable Object value, IdentityHashMap<Object, Boolean> path) {
		if (value instanceof Map<?, ?> map) {
			return toJsonMap(map, path);
		}
		if (value instanceof Collection<?> items) {
			if (path.put(items, Boolean.TRUE) != null) {
				return List.of();
			}
			List<@Nullable Object> list = new ArrayList<>(items.size());
			for (Object item : items) {
				list.add(toJson(item, path));
			}
			path.remove(items);
			return list;
		}
		if (value instanceof Optional<?> optional) {
			return optional.map((v) -> toJson(v, path)).orElse(null);
		}
		return value;
	}

	/** Maps snakeyaml marks (line and code-point column within the YAML text) to full-file positions. */
	private static final class Positions {

		private final String text;

		private final int[] lineStarts;

		private final int firstLine;

		Positions(String text, int[] lineStarts, int firstLine) {
			this.text = text;
			this.lineStarts = lineStarts;
			this.firstLine = firstLine;
		}

		int line(Mark mark) {
			return this.firstLine + mark.getLine();
		}

		int offset(Mark mark) {
			int line = Math.min(line(mark), this.lineStarts.length - 1);
			int start = this.lineStarts[line];
			int offset = start;
			int column = mark.getColumn();
			while (column > 0 && offset < this.text.length()) {
				offset += Character.charCount(this.text.codePointAt(offset));
				column--;
			}
			return offset;
		}

		int lineOf(int offset) {
			int index = Arrays.binarySearch(this.lineStarts, offset);
			return index >= 0 ? index : -index - 2;
		}

	}

}
