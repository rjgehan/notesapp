package com.rjgehan.notes.drawings;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.LinkTextGenerator;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * Indexes Excalidraw drawings for search, backlinks and tags (ROADMAP item 5, DESIGN §6.8.1).
 * <ul>
 * <li>{@code .excalidraw}: every text element is a block of Markdown, so its {@code [[links]]} and {@code #tags}
 * count as in a note; every element link is a link ({@code [[Note]]} as written, a relative path as the editor opens
 * it, web links are skipped); every image stored as a vault attachment is an embed of that file; frame names are
 * searchable.</li>
 * <li>{@code .excalidraw.md} is a note, and the Obsidian plugin keeps its texts and links in the Markdown (the
 * {@code ## Text Elements} and {@code ## Element Links} sections), which the note scan already indexes, with links a
 * rename can update. The blocks here supplement it with what only the drawing's JSON holds (it is decompressed when
 * it is {@code compressed-json}): texts without a Text Elements entry and links without an Element Links entry, the
 * elements the plugin itself would add to those sections when it next saves.</li>
 * </ul>
 * Files that are not readable drawings are not content-indexed beyond the note scan.
 */
@Component
public class ExcalidrawDocumentIndexer implements DocumentIndexer {

	private static final String EXTENSION = ".excalidraw";

	private static final String MARKDOWN_EXTENSION = ".excalidraw.md";

	private static final Pattern WIKILINK = Pattern.compile("!?\\[\\[[^\\[\\]\\n]+\\]\\]");

	private static final Pattern SCHEME = Pattern.compile("[A-Za-z][A-Za-z0-9+.-]*:");

	private static final Pattern PLAIN_DESTINATION = Pattern.compile("[^\\s()<>]+");

	private final JsonMapper mapper;

	public ExcalidrawDocumentIndexer(JsonMapper mapper) {
		this.mapper = mapper;
	}

	/** True for the paths the drawing view opens: {@code .excalidraw} and {@code .excalidraw.md}. */
	public static boolean isDrawing(String path) {
		String lower = PathNames.lower(path);
		return lower.endsWith(EXTENSION) || lower.endsWith(MARKDOWN_EXTENSION);
	}

	@Override
	public boolean supports(String path) {
		return isDrawing(path);
	}

	@Override
	public @Nullable Document index(String path, String text) {
		if (PathNames.lower(path).endsWith(MARKDOWN_EXTENSION)) {
			return supplement(text);
		}
		if (text.isBlank()) {
			// A new, empty file is an empty drawing.
			return new Document(List.of());
		}
		DrawingScene scene = DrawingScene.read(this.mapper, text);
		if (scene == null) {
			return null;
		}
		List<String> blocks = new ArrayList<>();
		for (DrawingScene.Element element : scene.elements()) {
			if (element.deleted()) {
				continue;
			}
			addText(blocks, element);
			addLink(blocks, element.link());
			String attachment = (element.fileId() != null) ? scene.attachmentPaths().get(element.fileId()) : null;
			if ("image".equals(element.type()) && attachment != null && !attachment.isBlank()) {
				blocks.add(embed(attachment));
			}
		}
		return new Document(List.copyOf(blocks));
	}

	/** What only the JSON of an {@code .excalidraw.md} drawing holds; null when it has no readable drawing. */
	private @Nullable Document supplement(String text) {
		MarkdownDrawing drawing = MarkdownDrawing.parse(text);
		DrawingScene scene = (drawing != null) ? DrawingScene.read(this.mapper, drawing.json()) : null;
		if (drawing == null || scene == null) {
			return null;
		}
		Map<String, String> texts = drawing.texts();
		List<String> blocks = new ArrayList<>();
		for (DrawingScene.Element element : scene.elements()) {
			if (element.deleted()) {
				continue;
			}
			String entry = texts.get(element.id());
			if (!element.isText() || entry == null) {
				addText(blocks, element);
			}
			String link = element.link();
			// Covered: an Element Links line, a link entry of the plugin's older layout (a non-text element under
			// Text Elements), or a text whose Markdown holds the link (the plugin derives a text's link from it).
			boolean covered = drawing.linkIds().contains(element.id())
					|| (entry != null && (!element.isText() || (link != null && entry.contains(link.strip()))));
			if (!covered) {
				addLink(blocks, link);
			}
		}
		return new Document(List.copyOf(blocks));
	}

	private static void addText(List<String> blocks, DrawingScene.Element element) {
		if (element.isText() && element.text() != null && !element.text().isBlank()) {
			blocks.add(element.text());
		}
		// Frames are named; their names show on the canvas.
		if (element.name() != null && !element.name().isBlank() && element.type().endsWith("frame")) {
			blocks.add(oneLine(element.name()));
		}
	}

	private static void addLink(List<String> blocks, @Nullable String link) {
		String markup = (link != null) ? linkMarkup(link) : null;
		if (markup != null) {
			blocks.add(markup);
		}
	}

	/**
	 * An element link as Markdown: {@code [[Note]]} as written; a path without a URI scheme as a Markdown link, which
	 * the scanner percent-decodes and splits at {@code #} just as the editor does when it opens the link; null for web
	 * links and anything else.
	 */
	static @Nullable String linkMarkup(String link) {
		String value = link.strip();
		if (value.isEmpty() || value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
			return null;
		}
		if (WIKILINK.matcher(value).matches()) {
			return value;
		}
		if (SCHEME.matcher(value).lookingAt() || value.startsWith("//")) {
			return null;
		}
		String label = value.replace('[', ' ').replace(']', ' ');
		if (PLAIN_DESTINATION.matcher(value).matches()) {
			return "[" + label + "](" + value + ")";
		}
		if (value.indexOf('<') < 0 && value.indexOf('>') < 0) {
			return "[" + label + "](<" + value + ">)";
		}
		return null;
	}

	/** An embed that resolves to exactly this vault path: forced absolute and percent-encoded. */
	private static String embed(String path) {
		String label = PathNames.nameOf(path).replace('[', ' ').replace(']', ' ').replace('\n', ' ');
		return "![" + label + "](/" + LinkTextGenerator.encodeMdPath(path) + ")";
	}

	private static String oneLine(String text) {
		return text.replace('\r', ' ').replace('\n', ' ');
	}

}
