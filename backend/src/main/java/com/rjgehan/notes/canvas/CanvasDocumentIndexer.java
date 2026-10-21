package com.rjgehan.notes.canvas;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.LinkTextGenerator;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * Indexes JSON Canvas files ({@code .canvas}, ROADMAP item 25) through the {@link DocumentIndexer} extension point
 * (DESIGN §6.8, §6.8.2): the text of cards, group names, web addresses and edge labels are searchable, the Markdown in
 * cards contributes its links and tags, and every file node is an embed of its file, so a note placed on a canvas lists
 * the canvas among its backlinks.
 * <p>
 * The blocks follow the file's order: each node's in turn (a text card's Markdown as written, a group's name, a link
 * node's address, and for a file node an embed that resolves to exactly its path, with its subpath), then each edge's
 * label. Each block is scanned on its own, so an unclosed code fence in one card cannot hide the links of the next,
 * and a card never has frontmatter.
 * <p>
 * After a move, {@link #rewriteLinks} rewrites the links in cards, group names and edge labels as a note's at the
 * canvas's path would be, and a file node's {@code file} follows the file it names. Only those JSON strings are
 * replaced; every other byte of the file stays as it was.
 */
@Component
public class CanvasDocumentIndexer implements DocumentIndexer {

	private static final String EXTENSION = ".canvas";

	private static final String NODES = "nodes";

	private static final String EDGES = "edges";

	private final JsonMapper mapper;

	public CanvasDocumentIndexer(JsonMapper mapper) {
		this.mapper = mapper;
	}

	@Override
	public boolean supports(String path) {
		return PathNames.lower(path).endsWith(EXTENSION);
	}

	@Override
	public @Nullable Document index(String path, String text) {
		if (text.isBlank()) {
			// A new, empty file is an empty canvas.
			return new Document(List.of());
		}
		JsonNode root = read(text);
		if (root == null) {
			return null;
		}
		List<String> blocks = new ArrayList<>();
		for (JsonNode node : items(root, NODES)) {
			if (!node.isObject()) {
				continue;
			}
			String type = string(node, "type");
			if (type == null) {
				continue;
			}
			switch (type) {
				case "text" -> addMarkdown(blocks, string(node, "text"));
				case "group" -> addMarkdown(blocks, string(node, "label"));
				case "link" -> addMarkdown(blocks, string(node, "url"));
				case "file" -> {
					String file = string(node, "file");
					if (file != null && !file.isBlank()) {
						blocks.add(embed(file, string(node, "subpath")));
					}
				}
				default -> {
					// Unknown node types carry nothing this index understands.
				}
			}
		}
		for (JsonNode edge : items(root, EDGES)) {
			if (edge.isObject()) {
				addMarkdown(blocks, string(edge, "label"));
			}
		}
		return new Document(List.copyOf(blocks));
	}

	@Override
	public @Nullable Rewritten rewriteLinks(String path, String text, LinkRewriter links) {
		if (text.isBlank()) {
			return new Rewritten(text, 0);
		}
		JsonNode root = read(text);
		Map<String, int[]> strings = (root != null) ? stringSpans(text) : null;
		if (root == null || strings == null) {
			return null;
		}
		// Replacements by start offset; applied from the end so earlier offsets stay valid.
		List<int[]> spans = new ArrayList<>();
		List<String> values = new ArrayList<>();
		int count = 0;
		for (String array : List.of(NODES, EDGES)) {
			List<JsonNode> items = items(root, array);
			for (int i = 0; i < items.size(); i++) {
				JsonNode item = items.get(i);
				if (!item.isObject()) {
					continue;
				}
				String type = array.equals(EDGES) ? "edge" : string(item, "type");
				String field = switch ((type != null) ? type : "") {
					case "text" -> "text";
					case "group", "edge" -> "label";
					case "file" -> "file";
					default -> null;
				};
				String value = (field != null) ? string(item, field) : null;
				if (value == null || value.isBlank()) {
					continue;
				}
				String changed;
				int changes;
				if ("file".equals(field)) {
					changed = links.path(value);
					changes = changed.equals(value) ? 0 : 1;
				}
				else {
					Rewritten rewritten = links.markdown(value);
					if (rewritten == null) {
						return null;
					}
					changed = rewritten.text();
					changes = rewritten.links();
				}
				if (changes == 0 || changed.equals(value)) {
					continue;
				}
				int[] span = strings.get(array + "/" + i + "/" + field);
				if (span == null) {
					return null;
				}
				spans.add(span);
				values.add(this.mapper.writeValueAsString(changed));
				count += changes;
			}
		}
		if (count == 0) {
			return new Rewritten(text, 0);
		}
		Integer[] order = new Integer[spans.size()];
		for (int i = 0; i < order.length; i++) {
			order[i] = i;
		}
		Arrays.sort(order, (a, b) -> Integer.compare(spans.get(b)[0], spans.get(a)[0]));
		StringBuilder out = new StringBuilder(text);
		for (int i : order) {
			out.replace(spans.get(i)[0], spans.get(i)[1], values.get(i));
		}
		return new Rewritten(out.toString(), count);
	}

	private @Nullable JsonNode read(String text) {
		try {
			JsonNode root = this.mapper.readTree(text);
			return (root != null && root.isObject()) ? root : null;
		}
		catch (JacksonException ex) {
			return null;
		}
	}

	/**
	 * Where each string value of an item's field sits in the text, quotes included, keyed
	 * {@code nodes/<index>/<field>} or {@code edges/<index>/<field>}; the last occurrence wins, as in the tree. Null
	 * when the parser cannot report character offsets.
	 */
	private @Nullable Map<String, int[]> stringSpans(String text) {
		Map<String, int[]> spans = new HashMap<>();
		try (JsonParser p = this.mapper.createParser(text)) {
			int depth = 0;
			String array = null;
			String field = null;
			int index = -1;
			JsonToken token;
			while ((token = p.nextToken()) != null) {
				if (token == JsonToken.PROPERTY_NAME) {
					if (depth == 1) {
						array = p.currentName();
						index = -1;
					}
					else if (depth == 3) {
						field = p.currentName();
					}
					continue;
				}
				if (depth == 2 && token != JsonToken.END_ARRAY) {
					index++;
				}
				if (token.isStructStart()) {
					depth++;
				}
				else if (token.isStructEnd()) {
					depth--;
				}
				else if (token == JsonToken.VALUE_STRING && depth == 3 && field != null
						&& (NODES.equals(array) || EDGES.equals(array))) {
					long start = p.currentTokenLocation().getCharOffset();
					int end = (start >= 0) ? stringEnd(text, (int) start) : -1;
					if (end < 0) {
						return null;
					}
					spans.put(array + "/" + index + "/" + field, new int[] { (int) start, end });
				}
			}
		}
		catch (JacksonException ex) {
			return null;
		}
		return spans;
	}

	/** The offset after the JSON string literal that starts at {@code start}, or -1 when none starts there. */
	private static int stringEnd(String text, int start) {
		if (start >= text.length() || text.charAt(start) != '"') {
			return -1;
		}
		for (int i = start + 1; i < text.length(); i++) {
			char c = text.charAt(i);
			if (c == '\\') {
				i++;
			}
			else if (c == '"') {
				return i + 1;
			}
		}
		return -1;
	}

	/** The array {@code name} of the canvas, or nothing when it is missing or not an array. */
	private static List<JsonNode> items(JsonNode root, String name) {
		JsonNode array = root.path(name);
		return array.isArray() ? array.values().stream().toList() : List.of();
	}

	private static @Nullable String string(JsonNode node, String field) {
		JsonNode value = node.path(field);
		return value.isString() ? value.stringValue() : null;
	}

	private static void addMarkdown(List<String> blocks, @Nullable String text) {
		if (text != null && !text.isBlank()) {
			blocks.add(text);
		}
	}

	/** An embed that resolves to exactly this vault path: forced absolute and percent-encoded, with the subpath. */
	static String embed(String path, @Nullable String subpath) {
		String label = PathNames.nameOf(path).replace('[', ' ').replace(']', ' ').replace('\n', ' ');
		String anchor = (subpath != null && subpath.startsWith("#") && subpath.length() > 1)
				? "#" + LinkTextGenerator.encodeMdPath(subpath.substring(1)) : "";
		return "![" + label + "](/" + LinkTextGenerator.encodeMdPath(path) + anchor + ")";
	}

}
