package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;

import com.rjgehan.notes.vault.TextCodec;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.core.TokenStreamLocation;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * One {@code .tasks} file as a mutable JSON tree (ROADMAP item 4, DESIGN §5.20):
 *
 * <pre>
 * { "type": "notesapp-tasks", "version": 1, "list": { "id": "01J…", "name": "Home", "order": "a0", … },
 *   "tasks": [ { "id": "01J…", "title": "Pay rent", … } ] }
 * </pre>
 *
 * An archive file has {@code "archive": true} and a copy of its list's {@code id} and {@code name}. Edits change
 * single fields of the tree, so fields this version does not know, and tasks it cannot read, survive every write.
 * {@link #serialize} writes the canonical form: two-space indentation, known keys in a fixed order (unknown keys
 * after them, in their own order), tasks sorted by id, and a final newline, so git diffs stay small and readable.
 */
final class TaskFile {

	static final String TYPE = "notesapp-tasks";

	static final int FORMAT_VERSION = 1;

	static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	private static final List<String> ROOT_KEYS = List.of("type", "version", "archive", "list", "tasks");

	private static final List<String> LIST_KEYS = List.of("id", "name", "color", "icon", "order", "archived",
			"sections");

	private static final List<String> SECTION_KEYS = List.of("id", "name", "order");

	static final List<String> TASK_KEYS = List.of("id", "title", "status", "priority", "sectionId", "parentId", "due",
			"start", "recurrence", "reminders", "tags", "links", "notes", "order", "createdAt", "updatedAt",
			"completedAt");

	private static final Comparator<JsonNode> BY_ID = Comparator
		.comparing((JsonNode node) -> node.isObject() && node.path("id").isString() ? 0 : 1)
		.thenComparing((node) -> node.path("id").isString() ? node.path("id").stringValue() : "");

	/** Why a file cannot be used; it is reported and never written. */
	static final class MalformedException extends Exception {

		MalformedException(String reason) {
			super(reason, null, false, false);
		}

	}

	final ObjectNode root;

	private final boolean hadBom;

	private TaskFile(ObjectNode root, boolean hadBom) {
		this.root = root;
		this.hadBom = hadBom;
	}

	/** A new list file. */
	static TaskFile newList(ObjectNode list) {
		ObjectNode root = NODES.objectNode();
		root.put("type", TYPE);
		root.put("version", FORMAT_VERSION);
		root.set("list", list);
		root.putArray("tasks");
		return new TaskFile(root, false);
	}

	/** A new archive file for the list {@code listId}. */
	static TaskFile newArchive(String listId, String name) {
		ObjectNode root = NODES.objectNode();
		root.put("type", TYPE);
		root.put("version", FORMAT_VERSION);
		root.put("archive", true);
		ObjectNode list = root.putObject("list");
		list.put("id", listId);
		list.put("name", name);
		root.putArray("tasks");
		return new TaskFile(root, false);
	}

	/**
	 * Parses and checks the file's frame: its type, format version, list id and name, and the shape of
	 * {@code tasks}. Single tasks are checked when they are read ({@link TaskCodec#readTask}).
	 */
	static TaskFile parse(byte[] bytes, JsonMapper mapper) throws MalformedException {
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		if (decoded.lossy()) {
			throw new MalformedException("not valid UTF-8");
		}
		return parse(decoded.text(), decoded.hadBom(), mapper);
	}

	/** Like {@link #parse(byte[], JsonMapper)}, for text already decoded (without its BOM). */
	static TaskFile parse(String text, boolean hadBom, JsonMapper mapper) throws MalformedException {
		JsonNode tree;
		try {
			// Anything after the JSON value would be lost on the next write, so it makes the file malformed.
			tree = mapper.readerFor(JsonNode.class)
				.with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
				.readValue(text);
		}
		catch (JacksonException ex) {
			TokenStreamLocation location = ex.getLocation();
			throw new MalformedException((location != null)
					? "not valid JSON (line " + location.getLineNr() + ", column " + location.getColumnNr() + ")"
					: "not valid JSON");
		}
		if (!(tree instanceof ObjectNode root) || !TYPE.equals(root.path("type").stringValue(null))) {
			throw new MalformedException("not a NotesApp tasks file (\"type\" must be \"" + TYPE + "\")");
		}
		JsonNode version = root.get("version");
		if (version == null || !version.isIntegralNumber() || !version.canConvertToInt() || version.intValue() < 1) {
			throw new MalformedException("\"version\" must be a whole number");
		}
		JsonNode archive = root.get("archive");
		if (archive != null && !archive.isBoolean() && !archive.isNull()) {
			throw new MalformedException("\"archive\" must be true or false");
		}
		if (!(root.get("list") instanceof ObjectNode list)) {
			throw new MalformedException("\"list\" must be an object");
		}
		String id = list.path("id").stringValue(null);
		if (id == null || !ID.matcher(id).matches()) {
			throw new MalformedException("\"list.id\" must be 1 to 64 letters, digits, - or _");
		}
		String name = list.path("name").stringValue(null);
		if (name == null || name.isBlank()) {
			throw new MalformedException("\"list.name\" must be a non-empty string");
		}
		JsonNode tasks = root.get("tasks");
		if (tasks != null && !tasks.isArray() && !tasks.isNull()) {
			throw new MalformedException("\"tasks\" must be an array");
		}
		if (tasks == null || tasks.isNull()) {
			root.putArray("tasks");
		}
		return new TaskFile(root, hadBom);
	}

	int formatVersion() {
		return this.root.path("version").intValue();
	}

	boolean isArchive() {
		return this.root.path("archive").asBoolean(false);
	}

	ObjectNode list() {
		return (ObjectNode) this.root.get("list");
	}

	String listId() {
		return list().path("id").stringValue();
	}

	String listName() {
		return list().path("name").stringValue();
	}

	private ArrayNode taskArray() {
		return (ArrayNode) this.root.get("tasks");
	}

	/** Every task object, in file order (array elements that are not objects are kept but never returned). */
	List<ObjectNode> tasks() {
		List<ObjectNode> tasks = new ArrayList<>();
		for (JsonNode node : taskArray()) {
			if (node instanceof ObjectNode task) {
				tasks.add(task);
			}
		}
		return tasks;
	}

	/** The first task object with this id. */
	@Nullable ObjectNode task(String id) {
		for (JsonNode node : taskArray()) {
			if (node instanceof ObjectNode task && id.equals(task.path("id").stringValue(null))) {
				return task;
			}
		}
		return null;
	}

	void addTask(ObjectNode task) {
		taskArray().add(task);
	}

	/** Removes the first task object with this id. */
	@Nullable ObjectNode removeTask(String id) {
		ArrayNode tasks = taskArray();
		for (int i = 0; i < tasks.size(); i++) {
			if (tasks.get(i) instanceof ObjectNode task && id.equals(task.path("id").stringValue(null))) {
				tasks.remove(i);
				return task;
			}
		}
		return null;
	}

	/** The canonical bytes of the file (the tree itself is left as it is). */
	byte[] serialize(ObjectWriter writer) {
		ObjectNode out = ordered(this.root, ROOT_KEYS);
		ObjectNode list = ordered(list(), LIST_KEYS);
		if (list.get("sections") instanceof ArrayNode sections) {
			ArrayNode orderedSections = NODES.arrayNode();
			for (JsonNode section : sections) {
				orderedSections.add((section instanceof ObjectNode object) ? ordered(object, SECTION_KEYS) : section);
			}
			list.set("sections", orderedSections);
		}
		out.set("list", list);
		List<JsonNode> tasks = new ArrayList<>();
		taskArray().forEach(tasks::add);
		tasks.sort(BY_ID);
		ArrayNode sorted = NODES.arrayNode();
		for (JsonNode task : tasks) {
			if (task instanceof ObjectNode object) {
				ObjectNode copy = ordered(object, TASK_KEYS);
				// A task belongs to the list of the file it is in; a stray listId (from a hand edit) would go stale.
				copy.remove("listId");
				sorted.add(copy);
			}
			else {
				sorted.add(task);
			}
		}
		out.set("tasks", sorted);
		return TextCodec.encode(writer.writeValueAsString(out) + "\n", this.hadBom);
	}

	/** A shallow copy with {@code keys} first, in that order, then every other key in its original order. */
	private static ObjectNode ordered(ObjectNode node, List<String> keys) {
		ObjectNode out = NODES.objectNode();
		for (String key : keys) {
			JsonNode value = node.get(key);
			if (value != null) {
				out.set(key, value);
			}
		}
		for (var entry : node.properties()) {
			if (!keys.contains(entry.getKey())) {
				out.set(entry.getKey(), entry.getValue());
			}
		}
		return out;
	}

}
