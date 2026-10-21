package com.rjgehan.notes.bookmarks;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;

import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.vault.VaultPaths;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Reads and checks bookmark items in Obsidian's {@code bookmarks.json} format (DESIGN §5.21):
 *
 * <pre>
 * { "type": "file",   "ctime": 1760616202120, "path": "Projects/Plan.md", "subpath": "#Goals", "title": "Goals" }
 * { "type": "folder", "ctime": …, "path": "Projects" }
 * { "type": "search", "ctime": …, "query": "tag:#work" }
 * { "type": "group",  "ctime": …, "title": "Reading", "items": [ … ] }
 * </pre>
 *
 * Other types Obsidian writes ({@code url}, {@code graph}) and fields this build does not know are kept as they are.
 * The same rules check a {@code PUT} body, where every problem is a {@link FieldError} (a 400), and the file on disk,
 * where an item that breaks them is dropped (it was edited by hand), so the client never gets an item it could not
 * send back. Paths are NFC-normalized; nothing else is changed.
 */
final class BookmarkCodec {

	static final int MAX_ITEMS = 5000;

	static final int MAX_DEPTH = 8;

	static final int MAX_TEXT = 1024;

	static final int MAX_TYPE = 64;

	static final String FILE = "file";

	static final String FOLDER = "folder";

	static final String SEARCH = "search";

	static final String GROUP = "group";

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	private BookmarkCodec() {
	}

	/** The checked items (paths NFC-normalized) and every problem found. */
	record Parsed(List<ObjectNode> items, List<FieldError> errors) {
	}

	/** A {@code PUT} body's {@code items}: the caller refuses the request when any error is reported. */
	static Parsed read(@Nullable JsonNode items) {
		if (items == null || !items.isArray()) {
			return new Parsed(List.of(),
					List.of(new FieldError("items", (items == null) ? "is required" : "must be a list")));
		}
		Reader reader = new Reader();
		List<ObjectNode> out = reader.list(items, "items", 1);
		return new Parsed(out, List.copyOf(reader.errors));
	}

	/** The file's {@code items} without the ones that break the rules (reported); a missing list is empty. */
	static Parsed readFile(@Nullable JsonNode root) {
		JsonNode items = (root != null) ? root.get("items") : null;
		if (items == null || !items.isArray()) {
			return new Parsed(List.of(),
					(items == null) ? List.of() : List.of(new FieldError("items", "must be a list")));
		}
		Reader reader = new Reader();
		List<ObjectNode> out = reader.list(items, "items", 1);
		return new Parsed(out, List.copyOf(reader.errors));
	}

	/** The document: {@code items} first, then the other fields of {@code root}, kept as they are. */
	static ObjectNode document(@Nullable JsonNode root, List<ObjectNode> items) {
		ObjectNode out = NODES.objectNode();
		ArrayNode list = NODES.arrayNode();
		items.forEach(list::add);
		out.set("items", list);
		if (root instanceof ObjectNode object) {
			object.properties().forEach((entry) -> {
				if (!entry.getKey().equals("items")) {
					out.set(entry.getKey(), entry.getValue().deepCopy());
				}
			});
		}
		return out;
	}

	/**
	 * Copies of {@code items} with {@code rewrite} applied to the {@code path} of every file and folder bookmark, in
	 * groups too. {@code rewrite} returns null to keep a path. Returns null when no path changed.
	 */
	static @Nullable List<ObjectNode> rewritePaths(List<ObjectNode> items, PathRewrite rewrite) {
		return map(items, (item) -> {
			String type = text(item, "type");
			String path = text(item, "path");
			if (type == null || path == null || !(type.equals(FILE) || type.equals(FOLDER))) {
				return item;
			}
			String next = rewrite.apply(type, path);
			if (next == null || next.equals(path)) {
				return item;
			}
			ObjectNode copy = item.deepCopy();
			copy.put("path", next);
			return copy;
		});
	}

	/** A path rewrite: the item's type and path in, the new path out (null keeps it). */
	@FunctionalInterface
	interface PathRewrite {

		@Nullable String apply(String type, String path);

	}

	/**
	 * Copies of {@code items} with {@code rewrite} applied to every file bookmark (in groups too); it returns the item to
	 * keep, the same object when nothing changes. Returns null when none changed.
	 */
	static @Nullable List<ObjectNode> rewriteFileItems(List<ObjectNode> items, UnaryOperator<ObjectNode> rewrite) {
		return map(items, (item) -> FILE.equals(text(item, "type")) ? rewrite.apply(item) : item);
	}

	/** {@code op} over every bookmark that is not a group, in groups too; null when it changed none. */
	private static @Nullable List<ObjectNode> map(List<ObjectNode> items, UnaryOperator<ObjectNode> op) {
		boolean changed = false;
		List<ObjectNode> out = new ArrayList<>(items.size());
		for (ObjectNode item : items) {
			ObjectNode next = item;
			if (GROUP.equals(text(item, "type"))) {
				if (item.get("items") instanceof ArrayNode children) {
					List<ObjectNode> nested = new ArrayList<>();
					children.values().forEach((child) -> {
						if (child instanceof ObjectNode object) {
							nested.add(object);
						}
					});
					List<ObjectNode> rewritten = map(nested, op);
					if (rewritten != null) {
						next = item.deepCopy();
						ArrayNode list = NODES.arrayNode();
						rewritten.forEach(list::add);
						next.set("items", list);
					}
				}
			}
			else {
				next = op.apply(item);
			}
			changed |= next != item;
			out.add(next);
		}
		return changed ? out : null;
	}

	static @Nullable String text(JsonNode item, String field) {
		JsonNode value = item.get(field);
		return (value != null && value.isString()) ? value.stringValue() : null;
	}

	/**
	 * Checks items field by field. An invalid item is left out of the result and reported; a {@code PUT} fails on any
	 * report, while the file keeps the rest.
	 */
	private static final class Reader {

		final List<FieldError> errors = new ArrayList<>();

		int count;

		List<ObjectNode> list(JsonNode items, String field, int depth) {
			List<ObjectNode> out = new ArrayList<>();
			int i = 0;
			for (JsonNode item : items.values()) {
				String itemField = field + "[" + i++ + "]";
				if (++this.count > MAX_ITEMS) {
					this.errors.add(new FieldError("items", "must have at most " + MAX_ITEMS + " bookmarks"));
					return out;
				}
				ObjectNode checked = item(item, itemField, depth);
				if (checked != null) {
					out.add(checked);
				}
			}
			return out;
		}

		private @Nullable ObjectNode item(JsonNode node, String field, int depth) {
			if (!(node instanceof ObjectNode item)) {
				return invalid(field, "must be an object");
			}
			ObjectNode out = item.deepCopy();
			String type = text(item, "type");
			if (type == null || type.isBlank() || type.length() > MAX_TYPE) {
				return invalid(field + ".type",
						(item.get("type") == null) ? "is required" : "must be a name of 1 to " + MAX_TYPE + " characters");
			}
			JsonNode ctime = item.get("ctime");
			if (ctime != null && !(ctime.isIntegralNumber() && ctime.canConvertToLong() && ctime.longValue() >= 0)) {
				return invalid(field + ".ctime", "must be a time in milliseconds");
			}
			if (!optionalText(item, field, "title")) {
				return null;
			}
			switch (type) {
				case FILE -> {
					if (!path(item, out, field) || !optionalText(item, field, "subpath")) {
						return null;
					}
					String subpath = text(item, "subpath");
					if (subpath != null && !subpath.startsWith("#")) {
						return invalid(field + ".subpath", "must start with #");
					}
				}
				case FOLDER -> {
					if (!path(item, out, field)) {
						return null;
					}
				}
				case SEARCH -> {
					String query = text(item, "query");
					if (query == null || query.isBlank() || query.length() > MAX_TEXT) {
						return invalid(field + ".query", (item.get("query") == null) ? "is required"
								: "must be a search of 1 to " + MAX_TEXT + " characters");
					}
				}
				case GROUP -> {
					JsonNode children = item.get("items");
					if (children == null || !children.isArray()) {
						return invalid(field + ".items", (children == null) ? "is required" : "must be a list");
					}
					if (depth >= MAX_DEPTH) {
						return invalid(field + ".items", "groups can be nested at most " + MAX_DEPTH + " deep");
					}
					ArrayNode list = NODES.arrayNode();
					list(children, field + ".items", depth + 1).forEach(list::add);
					out.set("items", list);
				}
				default -> {
					// Kept as it is: Obsidian's url and graph bookmarks, or a type from a newer build.
				}
			}
			return out;
		}

		private boolean path(ObjectNode item, ObjectNode out, String field) {
			JsonNode value = item.get("path");
			if (value == null || !value.isString()) {
				invalid(field + ".path", (value == null) ? "is required" : "must be a path");
				return false;
			}
			String nfc = Normalizer.normalize(value.stringValue(), Normalizer.Form.NFC);
			VaultPaths.Violation violation = VaultPaths.safetyViolation(nfc);
			if (violation != null) {
				invalid(field + ".path", "invalid path: " + violation.message());
				return false;
			}
			out.put("path", nfc);
			return true;
		}

		private boolean optionalText(ObjectNode item, String field, String name) {
			JsonNode value = item.get(name);
			if (value == null) {
				return true;
			}
			if (!value.isString() || value.stringValue().length() > MAX_TEXT) {
				invalid(field + "." + name, "must be text of at most " + MAX_TEXT + " characters");
				return false;
			}
			return true;
		}

		private <T> @Nullable T invalid(String field, String message) {
			this.errors.add(new FieldError(field, message));
			return null;
		}

	}

}
