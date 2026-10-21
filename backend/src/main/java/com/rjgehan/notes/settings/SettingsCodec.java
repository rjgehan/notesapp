package com.rjgehan.notes.settings;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;

import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.VaultPaths;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Reads settings from a JSON tree field by field and writes them back into it. Reading is lenient: a missing or
 * invalid field gets its default and a {@link FieldError}, so the same code validates a {@code PUT} body (errors are
 * a 400) and the file on disk (errors make the settings read-only, DESIGN §5.12). Writing merges the known fields into
 * the file's tree, so fields this build does not know are preserved.
 */
final class SettingsCodec {

	static final int MAX_FORMAT_LENGTH = 100;

	static final int MAX_EXCLUDED_PATHS = 100;

	static final int MAX_FOLDER_TEMPLATES = 100;

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	private SettingsCodec() {
	}

	/** The settings read from a tree and every problem found; defaults fill the gaps. */
	record Parsed(Settings settings, List<FieldError> errors) {
	}

	static Parsed read(@Nullable JsonNode node) {
		Reader reader = new Reader();
		Settings defaults = Settings.defaults();
		if (node == null || !node.isObject()) {
			reader.errors.add(new FieldError("settings", "must be an object"));
			return new Parsed(defaults, reader.errors);
		}
		int schemaVersion = reader.integer(node, "settings.schemaVersion", defaults.schemaVersion());
		if (schemaVersion != Settings.SCHEMA_VERSION) {
			reader.errors.add(new FieldError("settings.schemaVersion", "must be " + Settings.SCHEMA_VERSION));
		}
		JsonNode files = reader.group(node, "settings.files", "files");
		FilesSettings fd = defaults.files();
		FilesSettings filesSettings = new FilesSettings(
				reader.enumValue(files, "settings.files.newNoteLocation", NewNoteLocation.values(),
						fd.newNoteLocation()),
				reader.folder(files, "settings.files.newNoteFolder", fd.newNoteFolder()),
				reader.enumValue(files, "settings.files.newLinkFormat", LinkFormat.values(), fd.newLinkFormat()),
				reader.bool(files, "settings.files.useWikilinks", fd.useWikilinks()),
				reader.enumValue(files, "settings.files.attachmentLocation", AttachmentLocation.values(),
						fd.attachmentLocation()),
				reader.folder(files, "settings.files.attachmentFolder", fd.attachmentFolder()),
				reader.segment(files, "settings.files.attachmentSubfolder", fd.attachmentSubfolder()),
				reader.bool(files, "settings.files.autoUpdateLinks", fd.autoUpdateLinks()),
				reader.paths(files, "settings.files.excludedPaths", fd.excludedPaths()));
		JsonNode daily = reader.group(node, "settings.dailyNotes", "dailyNotes");
		DailyNotesSettings dd = defaults.dailyNotes();
		DailyNotesSettings dailySettings = new DailyNotesSettings(
				reader.format(daily, "settings.dailyNotes.format", dd.format()),
				reader.folder(daily, "settings.dailyNotes.folder", dd.folder()),
				reader.folder(daily, "settings.dailyNotes.template", dd.template()),
				reader.bool(daily, "settings.dailyNotes.openOnStartup", dd.openOnStartup()));
		JsonNode templates = reader.group(node, "settings.templates", "templates");
		TemplatesSettings td = defaults.templates();
		TemplatesSettings templatesSettings = new TemplatesSettings(
				reader.folder(templates, "settings.templates.folder", td.folder()),
				reader.format(templates, "settings.templates.dateFormat", td.dateFormat()),
				reader.format(templates, "settings.templates.timeFormat", td.timeFormat()),
				reader.folderTemplates(templates, "settings.templates.folderTemplates", td.folderTemplates()));
		JsonNode editor = reader.group(node, "settings.editor", "editor");
		EditorSettings ed = defaults.editor();
		EditorSettings editorSettings = new EditorSettings(
				reader.enumValue(editor, "settings.editor.defaultMode", EditorMode.values(), ed.defaultMode()),
				reader.bool(editor, "settings.editor.readableLineLength", ed.readableLineLength()),
				reader.bool(editor, "settings.editor.strictLineBreaks", ed.strictLineBreaks()));
		Settings settings = new Settings(Settings.SCHEMA_VERSION, filesSettings, dailySettings, templatesSettings,
				editorSettings);
		return new Parsed(settings, List.copyOf(reader.errors));
	}

	/** The integer {@code schemaVersion} of a settings tree, or null when it has none. */
	static @Nullable Integer schemaVersion(JsonNode node) {
		JsonNode value = node.get("schemaVersion");
		return (value != null && value.isIntegralNumber() && value.canConvertToInt()) ? value.intValue() : null;
	}

	/**
	 * A copy of {@code raw} with every known field set from {@code settings} and keys sorted at every level, so the file
	 * diffs well. Unknown fields keep their values.
	 */
	static ObjectNode merge(ObjectNode raw, Settings settings) {
		ObjectNode merged = raw.deepCopy();
		merged.put("schemaVersion", settings.schemaVersion());
		FilesSettings f = settings.files();
		ObjectNode files = group(merged, "files");
		files.put("newNoteLocation", wire(f.newNoteLocation()));
		files.put("newNoteFolder", f.newNoteFolder());
		files.put("newLinkFormat", wire(f.newLinkFormat()));
		files.put("useWikilinks", f.useWikilinks());
		files.put("attachmentLocation", wire(f.attachmentLocation()));
		files.put("attachmentFolder", f.attachmentFolder());
		files.put("attachmentSubfolder", f.attachmentSubfolder());
		files.put("autoUpdateLinks", f.autoUpdateLinks());
		ArrayNode excluded = NODES.arrayNode();
		f.excludedPaths().forEach(excluded::add);
		files.set("excludedPaths", excluded);
		DailyNotesSettings d = settings.dailyNotes();
		ObjectNode daily = group(merged, "dailyNotes");
		daily.put("format", d.format());
		daily.put("folder", d.folder());
		daily.put("template", d.template());
		daily.put("openOnStartup", d.openOnStartup());
		TemplatesSettings t = settings.templates();
		ObjectNode templates = group(merged, "templates");
		templates.put("folder", t.folder());
		templates.put("dateFormat", t.dateFormat());
		templates.put("timeFormat", t.timeFormat());
		ArrayNode rules = NODES.arrayNode();
		t.folderTemplates().forEach((rule) -> rules.addObject().put("folder", rule.folder()).put("template", rule.template()));
		templates.set("folderTemplates", rules);
		EditorSettings e = settings.editor();
		ObjectNode editor = group(merged, "editor");
		editor.put("defaultMode", wire(e.defaultMode()));
		editor.put("readableLineLength", e.readableLineLength());
		editor.put("strictLineBreaks", e.strictLineBreaks());
		return (ObjectNode) sorted(merged);
	}

	/** A copy of {@code node} whose object keys are sorted at every level. */
	static JsonNode sorted(JsonNode node) {
		if (node.isObject()) {
			Map<String, JsonNode> entries = new TreeMap<>();
			node.properties().forEach((entry) -> entries.put(entry.getKey(), sorted(entry.getValue())));
			ObjectNode out = NODES.objectNode();
			entries.forEach(out::set);
			return out;
		}
		if (node.isArray()) {
			ArrayNode out = NODES.arrayNode();
			node.values().forEach((item) -> out.add(sorted(item)));
			return out;
		}
		return node;
	}

	private static ObjectNode group(ObjectNode root, String name) {
		if (root.get(name) instanceof ObjectNode existing) {
			return existing;
		}
		ObjectNode created = NODES.objectNode();
		root.set(name, created);
		return created;
	}

	private static String wire(Enum<?> value) {
		return value.name().toLowerCase(Locale.ROOT);
	}

	/** Collects errors while reading fields; every accessor returns the default when the field is unusable. */
	private static final class Reader {

		final List<FieldError> errors = new ArrayList<>();

		@Nullable JsonNode group(JsonNode root, String field, String name) {
			JsonNode group = root.get(name);
			if (group == null || !group.isObject()) {
				this.errors.add(new FieldError(field, (group == null) ? "is required" : "must be an object"));
				return null;
			}
			return group;
		}

		int integer(JsonNode root, String field, int fallback) {
			JsonNode value = value(root, field);
			if (value == null) {
				return fallback;
			}
			if (!value.isIntegralNumber() || !value.canConvertToInt()) {
				return invalid(field, "must be an integer", fallback);
			}
			return value.intValue();
		}

		boolean bool(@Nullable JsonNode group, String field, boolean fallback) {
			JsonNode value = value(group, field);
			if (value == null) {
				return fallback;
			}
			if (!value.isBoolean()) {
				return invalid(field, "must be true or false", fallback);
			}
			return value.booleanValue();
		}

		<E extends Enum<E>> E enumValue(@Nullable JsonNode group, String field, E[] values, E fallback) {
			String text = string(group, field);
			if (text == null) {
				return fallback;
			}
			List<String> allowed = new ArrayList<>();
			for (E value : values) {
				if (wire(value).equals(text)) {
					return value;
				}
				allowed.add(wire(value));
			}
			return invalid(field, "must be one of " + String.join(", ", allowed), fallback);
		}

		String folder(@Nullable JsonNode group, String field, String fallback) {
			return checked(group, field, fallback, (s) -> s.isEmpty() ? null : pathViolation(s));
		}

		String segment(@Nullable JsonNode group, String field, String fallback) {
			return checked(group, field, fallback, (s) -> {
				if (s.contains("/")) {
					return "must be a single folder name";
				}
				String violation = pathViolation(s);
				return (violation != null) ? violation : NameRules.newNameViolation(s);
			});
		}

		String format(@Nullable JsonNode group, String field, String fallback) {
			return checked(group, field, fallback, (s) -> (s.isEmpty() || s.length() > MAX_FORMAT_LENGTH)
					? "must be 1 to " + MAX_FORMAT_LENGTH + " characters" : null);
		}

		List<String> paths(@Nullable JsonNode group, String field, List<String> fallback) {
			JsonNode value = value(group, field);
			if (value == null) {
				return fallback;
			}
			if (!value.isArray()) {
				return invalid(field, "must be a list of paths", fallback);
			}
			if (value.size() > MAX_EXCLUDED_PATHS) {
				return invalid(field, "must have at most " + MAX_EXCLUDED_PATHS + " entries", fallback);
			}
			List<String> paths = new ArrayList<>();
			int i = 0;
			for (JsonNode item : value.values()) {
				String itemField = field + "[" + i++ + "]";
				if (!item.isString()) {
					return invalid(itemField, "must be a path", fallback);
				}
				String violation = pathViolation(item.stringValue());
				if (violation != null) {
					return invalid(itemField, violation, fallback);
				}
				paths.add(item.stringValue());
			}
			return paths;
		}

		/**
		 * {@code templates.folderTemplates}: optional, since files written before it existed lack it (adding a field
		 * needs no schema bump, DESIGN §5.12). Each rule has a folder ({@code ""}: every folder) and a template path
		 * ({@code ""}: an unused row); a folder has at most one rule.
		 */
		List<TemplatesSettings.FolderTemplate> folderTemplates(@Nullable JsonNode group, String field,
				List<TemplatesSettings.FolderTemplate> fallback) {
			JsonNode value = (group == null) ? null : group.get(field.substring(field.lastIndexOf('.') + 1));
			if (value == null || value.isNull()) {
				return fallback;
			}
			if (!value.isArray()) {
				return invalid(field, "must be a list of folder templates", fallback);
			}
			if (value.size() > MAX_FOLDER_TEMPLATES) {
				return invalid(field, "must have at most " + MAX_FOLDER_TEMPLATES + " entries", fallback);
			}
			List<TemplatesSettings.FolderTemplate> rules = new ArrayList<>();
			List<String> folders = new ArrayList<>();
			int i = 0;
			for (JsonNode item : value.values()) {
				String itemField = field + "[" + i++ + "]";
				if (!item.isObject()) {
					return invalid(itemField, "must be an object", fallback);
				}
				int errors = this.errors.size();
				String folder = folder(item, itemField + ".folder", "");
				String template = folder(item, itemField + ".template", "");
				if (this.errors.size() > errors) {
					return fallback;
				}
				if (folders.contains(folder)) {
					return invalid(itemField + ".folder", "already has a template", fallback);
				}
				folders.add(folder);
				rules.add(new TemplatesSettings.FolderTemplate(folder, template));
			}
			return rules;
		}

		private String checked(@Nullable JsonNode group, String field, String fallback,
				Function<String, @Nullable String> rule) {
			String text = string(group, field);
			if (text == null) {
				return fallback;
			}
			String violation = rule.apply(text);
			return (violation != null) ? invalid(field, violation, fallback) : text;
		}

		/** The string value, or null (with an error recorded) when it is missing or not a string. */
		private @Nullable String string(@Nullable JsonNode group, String field) {
			JsonNode value = value(group, field);
			if (value == null) {
				return null;
			}
			if (!value.isString()) {
				this.errors.add(new FieldError(field, "must be a string"));
				return null;
			}
			return value.stringValue();
		}

		/** The field's node, or null when it is missing (an error) or its group is missing (already reported). */
		private @Nullable JsonNode value(@Nullable JsonNode group, String field) {
			if (group == null) {
				return null;
			}
			JsonNode value = group.get(field.substring(field.lastIndexOf('.') + 1));
			if (value == null || value.isNull()) {
				this.errors.add(new FieldError(field, "is required"));
				return null;
			}
			return value;
		}

		private <T> T invalid(String field, String message, T fallback) {
			this.errors.add(new FieldError(field, message));
			return fallback;
		}

		private static @Nullable String pathViolation(String path) {
			VaultPaths.Violation violation = VaultPaths
				.safetyViolation(Normalizer.normalize(path, Normalizer.Form.NFC));
			return (violation != null) ? "invalid path: " + violation.message() : null;
		}

	}

}
