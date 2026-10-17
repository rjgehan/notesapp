package com.rjgehan.notes.tasks;

import java.text.Normalizer;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.RecurrenceFrom;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskRecurrence;
import com.rjgehan.notes.api.dto.TaskReminder;
import com.rjgehan.notes.api.dto.TaskSection;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.index.Syntax;
import com.rjgehan.notes.vault.VaultPaths;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.NullNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Reads task and list objects for the API and validates the fields clients write (ROADMAP item 4 data model).
 * Reading is lenient where it can be: a task is unusable only when its id, title, status, priority, dates or links to
 * other tasks are invalid; smaller defects (a bad reminder, a non-string tag) are reported and the rest is served.
 * Writing is strict, and every value is normalized before it reaches a file.
 */
final class TaskCodec {

	static final int MAX_TITLE = 500;

	static final int MAX_NOTES = 100_000;

	static final int MAX_TAGS = 50;

	static final int MAX_LINKS = 50;

	static final int MAX_REMINDERS = 20;

	static final int MAX_NAME = 200;

	static final int MAX_SECTIONS = 100;

	private static final Pattern COLOR = Pattern.compile("#[0-9A-Fa-f]{6}|[a-z][a-z0-9-]{0,23}");

	private static final Pattern ICON = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");

	private static final int MAX_ICON = 64;

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	/** The task fields clients set ({@code TaskFields} in API.md §17). */
	enum Field {

		TITLE("title"), NOTES("notes"), STATUS("status"), PRIORITY("priority"), DUE("due"), START("start"),
		RECURRENCE("recurrence"), REMINDERS("reminders"), TAGS("tags"), LINKS("links"), LIST_ID("listId"),
		SECTION_ID("sectionId"), PARENT_ID("parentId");

		final String json;

		Field(String json) {
			this.json = json;
		}

	}

	/** The list fields clients set ({@code TaskListFields}). */
	enum ListField {

		NAME("name"), COLOR("color"), ICON("icon"), ARCHIVED("archived");

		final String json;

		ListField(String json) {
			this.json = json;
		}

	}

	/** A task read from a file and what is wrong with it; {@code task} is null when it cannot be used at all. */
	record ReadTask(@Nullable Task task, List<String> problems) {
	}

	private TaskCodec() {
	}

	// ---------------------------------------------------------------- reading

	static ReadTask readTask(ObjectNode node, String listId, boolean archived) {
		List<String> problems = new ArrayList<>();
		String id = node.path("id").stringValue(null);
		if (id == null || !TaskFile.ID.matcher(id).matches()) {
			return fatal("a task has no valid \"id\"");
		}
		String title = node.path("title").stringValue(null);
		if (title == null) {
			return fatal("\"title\" must be a string");
		}
		JsonNode statusNode = node.get("status");
		TaskStatus status = TaskStatus.OPEN;
		if (statusNode != null && !statusNode.isNull()) {
			status = status(statusNode.stringValue(null));
			if (status == null) {
				return fatal("\"status\" must be open, done or cancelled");
			}
		}
		JsonNode priorityNode = node.get("priority");
		int priority = 0;
		if (priorityNode != null && !priorityNode.isNull()) {
			if (!priorityNode.isIntegralNumber() || !priorityNode.canConvertToInt() || priorityNode.intValue() < 0
					|| priorityNode.intValue() > 3) {
				return fatal("\"priority\" must be 0, 1, 2 or 3");
			}
			priority = priorityNode.intValue();
		}
		String due = optionalString(node, "due");
		String start = optionalString(node, "start");
		if ((due != null && !TaskDates.isValid(due)) || (start != null && !TaskDates.isValid(start))) {
			return fatal("\"due\" and \"start\" must be YYYY-MM-DD or YYYY-MM-DDTHH:mm");
		}
		String sectionId = optionalString(node, "sectionId");
		String parentId = optionalString(node, "parentId");
		if (isWrongId(node, "sectionId", sectionId) || isWrongId(node, "parentId", parentId)) {
			return fatal("\"sectionId\" and \"parentId\" must be ids");
		}
		String notes = optionalString(node, "notes");
		if (notes == null && node.hasNonNull("notes")) {
			problems.add("\"notes\" is not a string");
		}
		TaskRecurrence recurrence = readRecurrence(node.get("recurrence"), problems);
		List<TaskReminder> reminders = new ArrayList<>();
		for (JsonNode reminder : arrayOf(node, "reminders", problems)) {
			String at = reminder.path("at").stringValue(null);
			if (TaskDates.isDateTime(at)) {
				reminders.add(new TaskReminder(at));
			}
			else {
				problems.add("a reminder has no valid \"at\" (YYYY-MM-DDTHH:mm)");
			}
		}
		List<String> tags = strings(node, "tags", problems);
		List<String> links = strings(node, "links", problems);
		String order = node.path("order").stringValue("");
		return new ReadTask(new Task(id, listId, sectionId, parentId, title, notes, status, priority, due, start,
				recurrence, List.copyOf(reminders), tags, links, order, instant(node, "createdAt", problems),
				instant(node, "updatedAt", problems), instant(node, "completedAt", problems), archived),
				List.copyOf(problems));
	}

	/** The list of a list file; defective optional fields are served as absent and reported. */
	static TaskList readList(ObjectNode list, String path, boolean writable, List<String> problems) {
		String color = optionalString(list, "color");
		if (color != null && !COLOR.matcher(color).matches()) {
			problems.add("\"list.color\" is not a #rrggbb color or a color name");
			color = null;
		}
		String icon = optionalString(list, "icon");
		if (icon != null && (icon.length() > MAX_ICON || !ICON.matcher(icon).matches())) {
			problems.add("\"list.icon\" is not an icon name");
			icon = null;
		}
		JsonNode archived = list.get("archived");
		if (archived != null && !archived.isBoolean() && !archived.isNull()) {
			problems.add("\"list.archived\" is not true or false");
		}
		List<TaskSection> sections = new ArrayList<>();
		Set<String> sectionIds = new LinkedHashSet<>();
		for (JsonNode section : arrayOf(list, "sections", problems)) {
			String id = section.path("id").stringValue(null);
			String name = section.path("name").stringValue(null);
			if (id == null || !TaskFile.ID.matcher(id).matches() || name == null || !sectionIds.add(id)) {
				problems.add("a section has no valid, unique \"id\" and \"name\"");
				continue;
			}
			sections.add(new TaskSection(id, name, section.path("order").stringValue("")));
		}
		sections.sort(TaskOrder.SECTIONS);
		return new TaskList(list.path("id").stringValue(), list.path("name").stringValue(), color, icon,
				list.path("order").stringValue(""), list.path("archived").asBoolean(false), List.copyOf(sections),
				path, writable);
	}

	private static ReadTask fatal(String problem) {
		return new ReadTask(null, List.of(problem));
	}

	private static @Nullable TaskStatus status(@Nullable String value) {
		if (value == null) {
			return null;
		}
		for (TaskStatus status : TaskStatus.values()) {
			if (status.wireName().equals(value)) {
				return status;
			}
		}
		return null;
	}

	private static @Nullable String optionalString(ObjectNode node, String key) {
		JsonNode value = node.get(key);
		return (value != null && value.isString()) ? value.stringValue() : null;
	}

	private static boolean isWrongId(ObjectNode node, String key, @Nullable String value) {
		if (value != null) {
			return !TaskFile.ID.matcher(value).matches();
		}
		return node.hasNonNull(key);
	}

	private static @Nullable TaskRecurrence readRecurrence(@Nullable JsonNode node, List<String> problems) {
		if (node == null || node.isNull()) {
			return null;
		}
		String rrule = node.path("rrule").stringValue(null);
		if (rrule == null) {
			problems.add("\"recurrence\" has no \"rrule\"");
			return null;
		}
		String from = node.path("from").stringValue("due");
		if (!from.equals("due") && !from.equals("completion")) {
			problems.add("\"recurrence.from\" is not due or completion");
		}
		return new TaskRecurrence(rrule, from.equals("completion") ? RecurrenceFrom.COMPLETION : RecurrenceFrom.DUE);
	}

	private static List<JsonNode> arrayOf(ObjectNode node, String key, List<String> problems) {
		JsonNode value = node.get(key);
		if (value == null || value.isNull()) {
			return List.of();
		}
		if (!value.isArray()) {
			problems.add("\"" + key + "\" is not an array");
			return List.of();
		}
		List<JsonNode> items = new ArrayList<>();
		value.forEach(items::add);
		return items;
	}

	private static List<String> strings(ObjectNode node, String key, List<String> problems) {
		List<String> values = new ArrayList<>();
		for (JsonNode item : arrayOf(node, key, problems)) {
			if (item.isString()) {
				values.add(item.stringValue());
			}
			else {
				problems.add("\"" + key + "\" has an entry that is not a string");
			}
		}
		return List.copyOf(values);
	}

	private static @Nullable Instant instant(ObjectNode node, String key, List<String> problems) {
		String value = optionalString(node, key);
		if (value == null) {
			if (node.hasNonNull(key)) {
				problems.add("\"" + key + "\" is not a date-time");
			}
			return null;
		}
		try {
			return Instant.parse(value);
		}
		catch (DateTimeParseException ex) {
			problems.add("\"" + key + "\" is not a date-time");
			return null;
		}
	}

	// ---------------------------------------------------------------- writing

	/**
	 * The fields present in {@code changes}, validated and normalized; a {@code NullNode} value clears the field.
	 * Unknown fields are ignored, like everywhere in the API. Problems go to {@code errors}, named
	 * {@code <prefix>.<field>}.
	 */
	static Map<Field, JsonNode> fields(JsonNode changes, String prefix, List<FieldError> errors) {
		Map<Field, JsonNode> fields = new EnumMap<>(Field.class);
		for (Field field : Field.values()) {
			JsonNode value = changes.get(field.json);
			if (value == null) {
				continue;
			}
			String name = prefix + "." + field.json;
			JsonNode normalized = switch (field) {
				case TITLE -> title(value, name, errors);
				case NOTES -> notes(value, name, errors);
				case STATUS -> (value.isString() && status(value.stringValue()) != null) ? value
						: error(errors, name, "must be open, done or cancelled");
				case PRIORITY -> (value.isIntegralNumber() && value.canConvertToInt() && value.intValue() >= 0
						&& value.intValue() <= 3) ? NODES.numberNode(value.intValue())
								: error(errors, name, "must be 0, 1, 2 or 3");
				case DUE, START -> (value.isNull() || (value.isString() && TaskDates.isValid(value.stringValue())))
						? value : error(errors, name, "must be null, YYYY-MM-DD or YYYY-MM-DDTHH:mm");
				case RECURRENCE -> recurrence(value, name, errors);
				case REMINDERS -> reminders(value, name, errors);
				case TAGS -> tags(value, name, errors);
				case LINKS -> links(value, name, errors);
				case LIST_ID -> isId(value) ? value : error(errors, name, "must be a list id");
				case SECTION_ID, PARENT_ID -> (value.isNull() || isId(value)) ? value
						: error(errors, name, "must be null or an id");
			};
			if (normalized != null) {
				fields.put(field, normalized);
			}
		}
		return fields;
	}

	/** Sets (or, for null, removes) one validated field on a task object. */
	static void apply(ObjectNode task, Field field, JsonNode value) {
		boolean empty = value.isNull() || (field == Field.REMINDERS && value.isEmpty());
		if (empty && field != Field.TAGS && field != Field.LINKS) {
			task.remove(field.json);
		}
		else if (field != Field.LIST_ID) {
			task.set(field.json, value);
		}
	}

	/** A field of a task as the API shows it, for comparing with what a client sent. */
	static JsonNode apiValue(Task task, Field field) {
		return switch (field) {
			case TITLE -> NODES.stringNode(task.title());
			case NOTES -> nullable(task.notes());
			case STATUS -> NODES.stringNode(task.status().wireName());
			case PRIORITY -> NODES.numberNode(task.priority());
			case DUE -> nullable(task.due());
			case START -> nullable(task.start());
			case RECURRENCE -> {
				TaskRecurrence recurrence = task.recurrence();
				yield (recurrence != null) ? recurrenceNode(recurrence.rrule(), recurrence.from()) : NullNode.instance;
			}
			case REMINDERS -> {
				ArrayNode reminders = NODES.arrayNode();
				task.reminders().forEach((reminder) -> reminders.addObject().put("at", reminder.at()));
				yield reminders;
			}
			case TAGS -> stringArray(task.tags());
			case LINKS -> stringArray(task.links());
			case LIST_ID -> NODES.stringNode(task.listId());
			case SECTION_ID -> nullable(task.sectionId());
			case PARENT_ID -> nullable(task.parentId());
		};
	}

	/** The list fields present in {@code changes}, validated and normalized. */
	static Map<ListField, JsonNode> listFields(JsonNode changes, String prefix, List<FieldError> errors) {
		Map<ListField, JsonNode> fields = new EnumMap<>(ListField.class);
		for (ListField field : ListField.values()) {
			JsonNode value = changes.get(field.json);
			if (value == null) {
				continue;
			}
			String name = prefix + "." + field.json;
			JsonNode normalized = switch (field) {
				case NAME -> {
					String listName = name(value.isString() ? value.stringValue() : null, name, errors);
					yield (listName != null) ? NODES.stringNode(listName) : null;
				}
				case COLOR -> (value.isNull() || (value.isString() && COLOR.matcher(value.stringValue()).matches()))
						? value : error(errors, name, "must be null, a #rrggbb color or a color name");
				case ICON -> (value.isNull() || (value.isString() && value.stringValue().length() <= MAX_ICON
						&& ICON.matcher(value.stringValue()).matches())) ? value
								: error(errors, name, "must be null or an icon name such as shopping-cart");
				case ARCHIVED -> value.isBoolean() ? value : error(errors, name, "must be true or false");
			};
			if (normalized != null) {
				fields.put(field, normalized);
			}
		}
		return fields;
	}

	static JsonNode apiValue(TaskList list, ListField field) {
		return switch (field) {
			case NAME -> NODES.stringNode(list.name());
			case COLOR -> nullable(list.color());
			case ICON -> nullable(list.icon());
			case ARCHIVED -> NODES.booleanNode(list.archived());
		};
	}

	/**
	 * A list or section name: trimmed, 1 to 200 characters, one line. Null (with an error) when it is not one.
	 */
	static @Nullable String name(@Nullable String value, String field, List<FieldError> errors) {
		String name = (value != null) ? Normalizer.normalize(value.strip(), Normalizer.Form.NFC) : null;
		if (name == null || name.isEmpty() || name.length() > MAX_NAME || hasControlCharacter(name)) {
			errors.add(new FieldError(field, "must be 1 to " + MAX_NAME + " characters on one line"));
			return null;
		}
		return name;
	}

	/** Whether two values a client and the server hold are the same (numbers by value, objects ignoring order). */
	static boolean same(@Nullable JsonNode a, @Nullable JsonNode b) {
		if (a == null || b == null) {
			return a == b;
		}
		if (a.isNumber() && b.isNumber()) {
			return a.decimalValue().compareTo(b.decimalValue()) == 0;
		}
		if (a.isArray() && b.isArray()) {
			if (a.size() != b.size()) {
				return false;
			}
			for (int i = 0; i < a.size(); i++) {
				if (!same(a.get(i), b.get(i))) {
					return false;
				}
			}
			return true;
		}
		if (a.isObject() && b.isObject()) {
			if (a.size() != b.size()) {
				return false;
			}
			for (String key : a.propertyNames()) {
				if (!same(a.get(key), b.get(key))) {
					return false;
				}
			}
			return true;
		}
		return a.equals(b);
	}

	static ObjectNode recurrenceNode(String rrule, RecurrenceFrom from) {
		ObjectNode node = NODES.objectNode();
		node.put("rrule", rrule);
		node.put("from", from.wireName());
		return node;
	}

	private static @Nullable JsonNode title(JsonNode value, String name, List<FieldError> errors) {
		String title = value.isString() ? Normalizer.normalize(value.stringValue().strip(), Normalizer.Form.NFC)
				: null;
		if (title == null || title.isEmpty() || title.length() > MAX_TITLE || hasControlCharacter(title)) {
			return error(errors, name, "must be 1 to " + MAX_TITLE + " characters on one line");
		}
		return NODES.stringNode(title);
	}

	private static @Nullable JsonNode notes(JsonNode value, String name, List<FieldError> errors) {
		if (value.isNull() || (value.isString() && value.stringValue().isBlank())) {
			return NullNode.instance;
		}
		if (!value.isString() || value.stringValue().length() > MAX_NOTES) {
			return error(errors, name, "must be null or text of at most " + MAX_NOTES + " characters");
		}
		return value;
	}

	private static @Nullable JsonNode recurrence(JsonNode value, String name, List<FieldError> errors) {
		if (value.isNull()) {
			return value;
		}
		String rrule = value.isObject() ? value.path("rrule").stringValue(null) : null;
		String from = value.isObject() ? value.path("from").stringValue("due") : null;
		if (rrule == null || from == null || (!from.equals("due") && !from.equals("completion"))) {
			return error(errors, name, "must be null or {rrule, from: due | completion}");
		}
		try {
			return recurrenceNode(Recurrence.normalize(rrule),
					from.equals("completion") ? RecurrenceFrom.COMPLETION : RecurrenceFrom.DUE);
		}
		catch (IllegalArgumentException ex) {
			return error(errors, name + ".rrule", ex.getMessage());
		}
	}

	private static @Nullable JsonNode reminders(JsonNode value, String name, List<FieldError> errors) {
		if (value.isNull()) {
			return NODES.arrayNode();
		}
		if (!value.isArray() || value.size() > MAX_REMINDERS) {
			return error(errors, name, "must be an array of at most " + MAX_REMINDERS + " reminders");
		}
		Set<String> seen = new LinkedHashSet<>();
		for (JsonNode reminder : value) {
			String at = reminder.isObject() ? reminder.path("at").stringValue(null) : null;
			if (!TaskDates.isDateTime(at)) {
				return error(errors, name, "each reminder must be {at: YYYY-MM-DDTHH:mm}");
			}
			seen.add(at);
		}
		ArrayNode reminders = NODES.arrayNode();
		seen.forEach((at) -> reminders.addObject().put("at", at));
		return reminders;
	}

	private static @Nullable JsonNode tags(JsonNode value, String name, List<FieldError> errors) {
		if (value.isNull()) {
			return NODES.arrayNode();
		}
		if (!value.isArray() || value.size() > MAX_TAGS) {
			return error(errors, name, "must be an array of at most " + MAX_TAGS + " tags");
		}
		Map<String, String> tags = new LinkedHashMap<>();
		for (JsonNode item : value) {
			String raw = item.isString() ? Normalizer.normalize(item.stringValue().strip(), Normalizer.Form.NFC)
					: null;
			String tag = (raw != null) ? Syntax.normalizeTag(raw.startsWith("#") ? raw.substring(1) : raw) : null;
			if (tag == null) {
				return error(errors, name, "each tag must be a valid #tag (letters, digits, - _ /, not only digits)");
			}
			tags.putIfAbsent(tag.toLowerCase(Locale.ROOT), tag);
		}
		return stringArray(List.copyOf(tags.values()));
	}

	private static @Nullable JsonNode links(JsonNode value, String name, List<FieldError> errors) {
		if (value.isNull()) {
			return NODES.arrayNode();
		}
		if (!value.isArray() || value.size() > MAX_LINKS) {
			return error(errors, name, "must be an array of at most " + MAX_LINKS + " vault paths");
		}
		Set<String> links = new LinkedHashSet<>();
		for (JsonNode item : value) {
			String path = item.isString() ? Normalizer.normalize(item.stringValue(), Normalizer.Form.NFC) : null;
			if (path == null || VaultPaths.safetyViolation(path) != null) {
				return error(errors, name, "each link must be a vault path such as Projects/Plan.md");
			}
			links.add(path);
		}
		return stringArray(List.copyOf(links));
	}

	private static boolean isId(JsonNode value) {
		return value.isString() && TaskFile.ID.matcher(value.stringValue()).matches();
	}

	private static @Nullable JsonNode error(List<FieldError> errors, String field, String message) {
		errors.add(new FieldError(field, message));
		return null;
	}

	private static JsonNode nullable(@Nullable String value) {
		return (value != null) ? NODES.stringNode(value) : NullNode.instance;
	}

	private static ArrayNode stringArray(List<String> values) {
		ArrayNode array = NODES.arrayNode();
		values.forEach(array::add);
		return array;
	}

	private static boolean hasControlCharacter(String text) {
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if (c < 0x20 || c == 0x7f || c == ' ' || c == ' ') {
				return true;
			}
		}
		return false;
	}

}
