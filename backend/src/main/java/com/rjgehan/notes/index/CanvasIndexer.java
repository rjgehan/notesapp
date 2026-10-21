package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.TextRange;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * Indexes JSON Canvas files ({@code .canvas}, ROADMAP item 25): the text of cards, group names, web addresses and
 * edge labels are searchable, the Markdown in cards contributes its links and tags, and every file node is a link to
 * its file, so a note placed on a canvas lists the canvas among its backlinks.
 * <p>
 * The searchable text has one block per item, in file order, separated by blank lines: a text card's Markdown as
 * written, a group's name, a link node's address, an edge's label, and a file node's path (with its subpath), which is
 * the context backlinks show for it. Each card is scanned on its own, so an unclosed code fence in one card cannot hide
 * the links of the next; a card never has frontmatter.
 */
@Component
public class CanvasIndexer implements DocumentIndexer {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private record Block(String text, boolean markdown, @Nullable String file, @Nullable String subpath) {
	}

	@Override
	public boolean supports(String path) {
		return path.toLowerCase(Locale.ROOT).endsWith(".canvas");
	}

	@Override
	public @Nullable Indexed index(String path, String text) {
		if (text.isBlank()) {
			return build(List.of());
		}
		JsonNode root;
		try {
			root = JSON.readTree(text);
		}
		catch (JacksonException ex) {
			return null;
		}
		if (root == null || !root.isObject()) {
			return null;
		}
		List<Block> blocks = new ArrayList<>();
		JsonNode nodes = root.path("nodes");
		if (nodes.isArray()) {
			for (JsonNode node : nodes.values()) {
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
							String subpath = string(node, "subpath");
							String shown = (subpath != null && !subpath.isEmpty()) ? file + subpath : file;
							blocks.add(new Block(shown, false, file, subpath));
						}
					}
					default -> {
						// Unknown node types carry nothing this index understands.
					}
				}
			}
		}
		JsonNode edges = root.path("edges");
		if (edges.isArray()) {
			for (JsonNode edge : edges.values()) {
				if (edge.isObject()) {
					addMarkdown(blocks, string(edge, "label"));
				}
			}
		}
		return build(blocks);
	}

	private static @Nullable String string(JsonNode node, String field) {
		JsonNode value = node.path(field);
		return value.isString() ? value.stringValue() : null;
	}

	private static void addMarkdown(List<Block> blocks, @Nullable String text) {
		if (text != null && !text.isBlank()) {
			// Line breaks are normalized like a note's; a lone \r would otherwise end no line.
			blocks.add(new Block(text.replace("\r\n", "\n").replace('\r', '\n'), true, null, null));
		}
	}

	private static Indexed build(List<Block> blocks) {
		StringBuilder out = new StringBuilder();
		List<TagOcc> tags = new ArrayList<>();
		List<HeadingOcc> headings = new ArrayList<>();
		List<LinkOcc> links = new ArrayList<>();
		List<String> blockIds = new ArrayList<>();
		List<TextRange> excluded = new ArrayList<>();
		List<TextRange> linkSpans = new ArrayList<>();
		int line = 0;
		for (Block block : blocks) {
			if (!out.isEmpty()) {
				out.append("\n\n");
				line += 2;
			}
			int start = out.length();
			out.append(block.text());
			if (block.markdown()) {
				// A leading newline keeps a card that starts with "---" from reading as frontmatter; its line 0 and
				// offset 0 are that newline, so positions shift by one less.
				NoteParse parse = MarkdownScanner.scan("\n" + block.text(), false, false);
				int offset = start - 1;
				int lines = line - 1;
				parse.tags().forEach((t) -> tags.add(new TagOcc(t.tag(), t.line() + lines, t.from() + offset,
						t.to() + offset, false)));
				parse.headings().forEach((h) -> headings.add(new HeadingOcc(h.level(), h.text(), h.line() + lines)));
				for (LinkOcc l : parse.links()) {
					links.add(new LinkOcc(l.raw(), l.target(), l.subpath(), l.display(), l.embed(), l.style(),
							l.angle(), l.line() + lines, l.from() + offset, l.to() + offset, l.targetFrom() + offset,
							l.targetTo() + offset, false, false, LinkOcc.Quoting.BODY));
				}
				blockIds.addAll(parse.blockIds());
				parse.excluded().forEach((r) -> excluded.add(new TextRange(r.from() + offset, r.to() + offset)));
				parse.linkSpans().forEach((r) -> linkSpans.add(new TextRange(r.from() + offset, r.to() + offset)));
			}
			else if (block.file() != null) {
				String file = block.file();
				String subpath = block.subpath();
				String target = (subpath != null && subpath.startsWith("#")) ? subpath.substring(1) : subpath;
				int end = out.length();
				links.add(new LinkOcc(block.text(), file, (target == null || target.isEmpty()) ? null : target, null,
						true, LinkStyle.WIKI, false, line, start, end, start, start + file.length(), false, false,
						LinkOcc.Quoting.BODY));
				linkSpans.add(new TextRange(start, end));
			}
			line += newlines(block.text());
		}
		String text = out.toString();
		NoteParse parse = new NoteParse(null, null, List.of(), List.copyOf(tags), List.copyOf(headings),
				List.copyOf(links), List.copyOf(blockIds), MarkdownScanner.lineStarts(text), List.copyOf(excluded),
				List.copyOf(linkSpans), false, false);
		return new Indexed(text, parse);
	}

	private static int newlines(String text) {
		int count = 0;
		for (int i = 0; i < text.length(); i++) {
			if (text.charAt(i) == '\n') {
				count++;
			}
		}
		return count;
	}

}
