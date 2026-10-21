package com.rjgehan.notes.drawings;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.json.JsonMapper;

/**
 * What the index needs from an Excalidraw scene ({@code {"type":"excalidraw","elements":[…],"files":{…}}}): each
 * element's id, type, text and link, and the vault path of each image stored as an attachment (DESIGN §6.8.1). The
 * JSON is streamed, so the data URLs of embedded images are skipped rather than copied, and unknown or oddly typed
 * properties are ignored the way the editor ignores them.
 */
public record DrawingScene(List<Element> elements, Map<String, String> attachmentPaths) {

	/**
	 * One element. {@code text} is a text element's Markdown source ({@code rawText}, which the Obsidian plugin and
	 * NotesApp keep for Markdown drawings), else its unwrapped text ({@code originalText}), else what it shows.
	 */
	public record Element(String id, String type, boolean deleted, @Nullable String text, @Nullable String link,
			@Nullable String name, @Nullable String fileId) {

		public boolean isText() {
			return "text".equals(this.type);
		}

	}

	/** The scene in {@code json}, or null when it is not an Excalidraw scene (the editor opens it as text then). */
	public static @Nullable DrawingScene read(JsonMapper mapper, String json) {
		try (JsonParser p = mapper.createParser(json)) {
			if (p.nextToken() != JsonToken.START_OBJECT) {
				return null;
			}
			List<Element> elements = List.of();
			Map<String, String> paths = Map.of();
			while (p.nextToken() == JsonToken.PROPERTY_NAME) {
				String property = p.currentName();
				JsonToken token = p.nextToken();
				switch (property) {
					case "type" -> {
						if (token != JsonToken.VALUE_STRING || !"excalidraw".equals(p.getString())) {
							return null;
						}
					}
					case "elements" -> {
						if (token == JsonToken.START_ARRAY) {
							elements = readElements(p);
							if (elements == null) {
								return null;
							}
						}
						else if (token != JsonToken.VALUE_NULL) {
							return null;
						}
					}
					case "files" -> {
						if (token == JsonToken.START_OBJECT) {
							paths = readFiles(p);
						}
						else {
							p.skipChildren();
						}
					}
					default -> p.skipChildren();
				}
			}
			return new DrawingScene(List.copyOf(elements), paths);
		}
		catch (JacksonException ex) {
			return null;
		}
	}

	/** The elements, or null when one has no string id or type (the editor refuses such a scene too). */
	private static @Nullable List<Element> readElements(JsonParser p) {
		List<Element> elements = new ArrayList<>();
		while (p.nextToken() == JsonToken.START_OBJECT) {
			String id = null;
			String type = null;
			boolean deleted = false;
			String rawText = null;
			String originalText = null;
			String text = null;
			String link = null;
			String name = null;
			String fileId = null;
			while (p.nextToken() == JsonToken.PROPERTY_NAME) {
				String property = p.currentName();
				JsonToken token = p.nextToken();
				if (token == JsonToken.VALUE_TRUE && "isDeleted".equals(property)) {
					deleted = true;
					continue;
				}
				if (token != JsonToken.VALUE_STRING) {
					p.skipChildren();
					continue;
				}
				switch (property) {
					case "id" -> id = p.getString();
					case "type" -> type = p.getString();
					case "rawText" -> rawText = p.getString();
					case "originalText" -> originalText = p.getString();
					case "text" -> text = p.getString();
					case "link" -> link = p.getString();
					case "name" -> name = p.getString();
					case "fileId" -> fileId = p.getString();
					default -> {
						// Another string property.
					}
				}
			}
			if (id == null || type == null) {
				return null;
			}
			String content = (rawText != null) ? rawText : (originalText != null) ? originalText : text;
			elements.add(new Element(id, type, deleted, content, link, name, fileId));
		}
		return (p.currentToken() == JsonToken.END_ARRAY) ? elements : null;
	}

	/** {@code files} entries that name a vault attachment by {@code path}; embedded data URLs are skipped. */
	private static Map<String, String> readFiles(JsonParser p) {
		Map<String, String> paths = new LinkedHashMap<>();
		while (p.nextToken() == JsonToken.PROPERTY_NAME) {
			String id = p.currentName();
			if (p.nextToken() != JsonToken.START_OBJECT) {
				p.skipChildren();
				continue;
			}
			while (p.nextToken() == JsonToken.PROPERTY_NAME) {
				String property = p.currentName();
				JsonToken token = p.nextToken();
				if (token == JsonToken.VALUE_STRING && "path".equals(property)) {
					paths.put(id, p.getString());
				}
				else {
					p.skipChildren();
				}
			}
		}
		return Map.copyOf(paths);
	}

}
