package com.rjgehan.notes.obsidian;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.rjgehan.notes.api.dto.CompatSetting;
import com.rjgehan.notes.api.dto.CompatSetting.Status;
import com.rjgehan.notes.settings.AttachmentLocation;
import com.rjgehan.notes.settings.DailyNotesSettings;
import com.rjgehan.notes.settings.EditorMode;
import com.rjgehan.notes.settings.EditorSettings;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.LinkFormat;
import com.rjgehan.notes.settings.NewNoteLocation;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsSeed;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.settings.TemplatesSettings;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.VaultPaths;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * Obsidian's settings in NotesApp terms (ROADMAP item 24, DESIGN §5.23): {@code app.json} (attachments, new notes,
 * links, excluded files, editor), {@code daily-notes.json} and {@code templates.json}. A vault that has no
 * {@code .notesapp/settings.json} yet starts with them ({@link SettingsSeed}); the compatibility report shows each
 * mapping and proposes the result for an existing installation. Values NotesApp cannot use are reported, never
 * applied.
 */
@Component
public class ObsidianSettings implements SettingsSeed {

	private static final Logger logger = LoggerFactory.getLogger(ObsidianSettings.class);

	private final ObsidianConfigReader reader;

	public ObsidianSettings(ObsidianConfigReader reader) {
		this.reader = reader;
	}

	/** The proposed settings and one row per Obsidian setting found. */
	public record Mapping(Settings proposed, List<CompatSetting> rows) {
	}

	@Override
	public Settings firstRun(Settings defaults) {
		ObsidianConfig config = this.reader.read();
		if (!config.found()) {
			return defaults;
		}
		Mapping mapping = map(config, defaults);
		long applied = mapping.rows().stream().filter((row) -> row.status() == Status.DIFFERENT).count();
		logger.info("Imported {} settings from {}/ ({})", applied, ObsidianConfigReader.FOLDER,
				String.join(", ", config.files()));
		return mapping.proposed();
	}

	/** Obsidian's settings applied to {@code current}. */
	public static Mapping map(ObsidianConfig config, Settings current) {
		Builder b = new Builder(current);
		ObjectNode app = config.app();
		if (app != null) {
			b.attachments(app.get("attachmentFolderPath"));
			b.newNotes(app.get("newFileLocation"), app.get("newFileFolderPath"));
			b.linkFormat(app.get("newLinkFormat"));
			b.wikilinks(app.get("useMarkdownLinks"));
			b.updateLinks(app.get("alwaysUpdateLinks"));
			b.excluded(app.get("userIgnoreFilters"));
			b.strictLineBreaks(app.get("strictLineBreaks"));
			b.readableLineLength(app.get("readableLineLength"));
			b.defaultMode(app.get("defaultViewMode"));
		}
		ObjectNode daily = config.dailyNotes();
		if (daily != null) {
			b.dailyFormat(daily.get("format"));
			b.dailyFolder(daily.get("folder"));
			b.dailyTemplate(daily.get("template"));
			b.dailyAutorun(daily.get("autorun"));
		}
		ObjectNode templates = config.templates();
		if (templates != null) {
			b.templatesFolder(templates.get("folder"));
			b.templatesFormat("dateFormat", templates.get("dateFormat"));
			b.templatesFormat("timeFormat", templates.get("timeFormat"));
		}
		Settings proposed = b.build();
		if (!SettingsService.validate(proposed).isEmpty()) {
			// Every value is checked on its own, so this cannot happen; never propose invalid settings anyway.
			return new Mapping(current, b.rows.stream()
				.map((row) -> new CompatSetting(row.source(), row.obsidianValue(), row.setting(), row.current(),
						row.current(), Status.UNSUPPORTED, "NotesApp cannot use this value"))
				.toList());
		}
		return new Mapping(proposed, List.copyOf(b.rows));
	}

	/** A folder path as NotesApp stores it: NFC, no leading or trailing slashes; null when it is not a valid path. */
	static @Nullable String folder(String value) {
		String folder = Normalizer.normalize(value.strip(), Normalizer.Form.NFC);
		while (folder.startsWith("/")) {
			folder = folder.substring(1);
		}
		while (folder.endsWith("/")) {
			folder = folder.substring(0, folder.length() - 1);
		}
		if (folder.isEmpty()) {
			return "";
		}
		return (VaultPaths.safetyViolation(folder) == null) ? folder : null;
	}

	private static String wire(Enum<?> value) {
		return value.name().toLowerCase(Locale.ROOT);
	}

	/** Collects the mapped values and the report rows. */
	private static final class Builder {

		private static final String APP = "app.json › ";

		private static final String DAILY = "daily-notes.json › ";

		private static final String TEMPLATES = "templates.json › ";

		final List<CompatSetting> rows = new ArrayList<>();

		private final Settings current;

		private NewNoteLocation newNoteLocation;

		private String newNoteFolder;

		private LinkFormat newLinkFormat;

		private boolean useWikilinks;

		private AttachmentLocation attachmentLocation;

		private String attachmentFolder;

		private String attachmentSubfolder;

		private boolean autoUpdateLinks;

		private List<String> excludedPaths;

		private String dailyFormat;

		private String dailyFolder;

		private String dailyTemplate;

		private boolean openOnStartup;

		private String templatesFolder;

		private String dateFormat;

		private String timeFormat;

		private EditorMode defaultMode;

		private boolean readableLineLength;

		private boolean strictLineBreaks;

		Builder(Settings current) {
			this.current = current;
			FilesSettings f = current.files();
			this.newNoteLocation = f.newNoteLocation();
			this.newNoteFolder = f.newNoteFolder();
			this.newLinkFormat = f.newLinkFormat();
			this.useWikilinks = f.useWikilinks();
			this.attachmentLocation = f.attachmentLocation();
			this.attachmentFolder = f.attachmentFolder();
			this.attachmentSubfolder = f.attachmentSubfolder();
			this.autoUpdateLinks = f.autoUpdateLinks();
			this.excludedPaths = f.excludedPaths();
			DailyNotesSettings d = current.dailyNotes();
			this.dailyFormat = d.format();
			this.dailyFolder = d.folder();
			this.dailyTemplate = d.template();
			this.openOnStartup = d.openOnStartup();
			TemplatesSettings t = current.templates();
			this.templatesFolder = t.folder();
			this.dateFormat = t.dateFormat();
			this.timeFormat = t.timeFormat();
			EditorSettings e = current.editor();
			this.defaultMode = e.defaultMode();
			this.readableLineLength = e.readableLineLength();
			this.strictLineBreaks = e.strictLineBreaks();
		}

		Settings build() {
			return new Settings(Settings.SCHEMA_VERSION,
					new FilesSettings(this.newNoteLocation, this.newNoteFolder, this.newLinkFormat, this.useWikilinks,
							this.attachmentLocation, this.attachmentFolder, this.attachmentSubfolder,
							this.autoUpdateLinks, this.excludedPaths),
					new DailyNotesSettings(this.dailyFormat, this.dailyFolder, this.dailyTemplate, this.openOnStartup),
					new TemplatesSettings(this.templatesFolder, this.dateFormat, this.timeFormat),
					new EditorSettings(this.defaultMode, this.readableLineLength, this.strictLineBreaks));
		}

		private void row(String source, JsonNode value, String setting, String current, String proposed,
				@Nullable String note) {
			this.rows.add(new CompatSetting(source, value.toString(), setting, current, proposed,
					current.equals(proposed) ? Status.SAME : Status.DIFFERENT, note));
		}

		private void unsupported(String source, @Nullable JsonNode value, @Nullable String setting, @Nullable String current,
				String note) {
			this.rows.add(new CompatSetting(source, String.valueOf(value), setting, current, null, Status.UNSUPPORTED,
					note));
		}

		private static @Nullable String text(@Nullable JsonNode value) {
			return (value != null && value.isString()) ? value.stringValue() : null;
		}

		private static boolean isBool(@Nullable JsonNode value) {
			return value != null && value.isBoolean();
		}

		private String attachmentsShown(AttachmentLocation location, String folder, String subfolder) {
			return switch (location) {
				case ROOT -> "vault root";
				case FOLDER -> "folder " + (folder.isEmpty() ? "(root)" : folder);
				case CURRENT -> "same folder as the note";
				case SUBFOLDER -> "subfolder " + subfolder + " next to the note";
			};
		}

		void attachments(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			String v = raw.strip();
			String before = attachmentsShown(this.attachmentLocation, this.attachmentFolder, this.attachmentSubfolder);
			String setting = "files.attachmentLocation";
			if (v.isEmpty() || v.equals("/")) {
				this.attachmentLocation = AttachmentLocation.ROOT;
			}
			else if (v.equals("./") || v.equals(".")) {
				this.attachmentLocation = AttachmentLocation.CURRENT;
			}
			else if (v.startsWith("./")) {
				String sub = v.substring(2);
				while (sub.endsWith("/")) {
					sub = sub.substring(0, sub.length() - 1);
				}
				sub = Normalizer.normalize(sub, Normalizer.Form.NFC);
				if (sub.isEmpty() || sub.contains("/") || NameRules.newNameViolation(sub) != null
						|| VaultPaths.safetyViolation(sub) != null) {
					unsupported(APP + "attachmentFolderPath", value, setting, before,
							"NotesApp's attachment subfolder is a single folder name next to the note");
					return;
				}
				this.attachmentLocation = AttachmentLocation.SUBFOLDER;
				this.attachmentSubfolder = sub;
			}
			else {
				String folder = folder(v);
				if (folder == null) {
					unsupported(APP + "attachmentFolderPath", value, setting, before, "Not a folder NotesApp can use");
					return;
				}
				this.attachmentLocation = folder.isEmpty() ? AttachmentLocation.ROOT : AttachmentLocation.FOLDER;
				if (!folder.isEmpty()) {
					this.attachmentFolder = folder;
				}
			}
			row(APP + "attachmentFolderPath", value, setting, before,
					attachmentsShown(this.attachmentLocation, this.attachmentFolder, this.attachmentSubfolder), null);
		}

		void newNotes(@Nullable JsonNode location, @Nullable JsonNode folderValue) {
			String raw = text(location);
			if (raw == null) {
				return;
			}
			String before = wire(this.newNoteLocation)
					+ (this.newNoteLocation == NewNoteLocation.FOLDER ? ": " + this.newNoteFolder : "");
			NewNoteLocation next = switch (raw) {
				case "root" -> NewNoteLocation.ROOT;
				case "current" -> NewNoteLocation.CURRENT;
				case "folder" -> NewNoteLocation.FOLDER;
				default -> null;
			};
			if (next == null) {
				unsupported(APP + "newFileLocation", location, "files.newNoteLocation", before, "Unknown value");
				return;
			}
			if (next == NewNoteLocation.FOLDER) {
				String folder = (text(folderValue) != null) ? folder(text(folderValue)) : "";
				if (folder == null) {
					unsupported(APP + "newFileFolderPath", folderValue, "files.newNoteFolder", before,
							"Not a folder NotesApp can use");
					return;
				}
				this.newNoteFolder = folder;
				// Obsidian's "folder" with an empty path is the vault root.
				next = folder.isEmpty() ? NewNoteLocation.ROOT : NewNoteLocation.FOLDER;
			}
			this.newNoteLocation = next;
			String after = wire(next) + (next == NewNoteLocation.FOLDER ? ": " + this.newNoteFolder : "");
			row(APP + "newFileLocation", location, "files.newNoteLocation", before, after, null);
		}

		void linkFormat(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			for (LinkFormat format : LinkFormat.values()) {
				if (wire(format).equals(raw)) {
					String before = wire(this.newLinkFormat);
					this.newLinkFormat = format;
					row(APP + "newLinkFormat", value, "files.newLinkFormat", before, raw, null);
					return;
				}
			}
			unsupported(APP + "newLinkFormat", value, "files.newLinkFormat", wire(this.newLinkFormat), "Unknown value");
		}

		void wikilinks(@Nullable JsonNode value) {
			if (!isBool(value)) {
				return;
			}
			String before = String.valueOf(this.useWikilinks);
			this.useWikilinks = !value.booleanValue();
			row(APP + "useMarkdownLinks", value, "files.useWikilinks", before, String.valueOf(this.useWikilinks),
					null);
		}

		void updateLinks(@Nullable JsonNode value) {
			if (!isBool(value)) {
				return;
			}
			if (value.booleanValue()) {
				String before = String.valueOf(this.autoUpdateLinks);
				this.autoUpdateLinks = true;
				row(APP + "alwaysUpdateLinks", value, "files.autoUpdateLinks", before, "true", null);
			}
			else {
				this.rows.add(new CompatSetting(APP + "alwaysUpdateLinks", value.toString(), "files.autoUpdateLinks",
						String.valueOf(this.autoUpdateLinks), String.valueOf(this.autoUpdateLinks), Status.SAME,
						"Obsidian asks every time; NotesApp's Move dialog lists the links it will update, with a switch"));
			}
		}

		void excluded(@Nullable JsonNode value) {
			if (value == null || !value.isArray()) {
				return;
			}
			List<String> paths = new ArrayList<>();
			List<String> skipped = new ArrayList<>();
			for (JsonNode item : value.values()) {
				String raw = text(item);
				if (raw == null || raw.isBlank()) {
					continue;
				}
				String path = raw.strip();
				// Obsidian also takes regular expressions (/.../); NotesApp only path prefixes.
				String folder = (path.length() > 1 && path.startsWith("/") && path.endsWith("/")) ? null : folder(path);
				if (folder == null || folder.isEmpty() || paths.size() >= 100) {
					skipped.add(raw);
				}
				else if (!paths.contains(folder)) {
					paths.add(folder);
				}
			}
			String before = String.join(", ", this.excludedPaths);
			this.excludedPaths = List.copyOf(paths);
			row(APP + "userIgnoreFilters", value, "files.excludedPaths", before, String.join(", ", paths),
					skipped.isEmpty() ? null
							: "Not used: " + String.join(", ", skipped)
									+ " (NotesApp excludes folders and files by path, not by regular expression)");
		}

		void strictLineBreaks(@Nullable JsonNode value) {
			if (!isBool(value)) {
				return;
			}
			String before = String.valueOf(this.strictLineBreaks);
			this.strictLineBreaks = value.booleanValue();
			row(APP + "strictLineBreaks", value, "editor.strictLineBreaks", before, String.valueOf(this.strictLineBreaks),
					null);
		}

		void readableLineLength(@Nullable JsonNode value) {
			if (!isBool(value)) {
				return;
			}
			String before = String.valueOf(this.readableLineLength);
			this.readableLineLength = value.booleanValue();
			row(APP + "readableLineLength", value, "editor.readableLineLength", before,
					String.valueOf(this.readableLineLength), null);
		}

		void defaultMode(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			String before = wire(this.defaultMode);
			if (raw.equals("source")) {
				this.defaultMode = EditorMode.EDIT;
			}
			else if (raw.equals("preview")) {
				this.defaultMode = EditorMode.READ;
			}
			else {
				unsupported(APP + "defaultViewMode", value, "editor.defaultMode", before, "Unknown value");
				return;
			}
			row(APP + "defaultViewMode", value, "editor.defaultMode", before, wire(this.defaultMode), null);
		}

		private @Nullable String format(String raw) {
			String format = raw.strip();
			return (format.isEmpty() || format.length() > 100) ? null : format;
		}

		void dailyFormat(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			// Obsidian leaves the field empty for its default.
			String format = raw.isBlank() ? "YYYY-MM-DD" : format(raw);
			if (format == null) {
				unsupported(DAILY + "format", value, "dailyNotes.format", this.dailyFormat, "Too long");
				return;
			}
			String before = this.dailyFormat;
			this.dailyFormat = format;
			row(DAILY + "format", value, "dailyNotes.format", before, format, null);
		}

		void dailyFolder(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			String folder = folder(raw);
			if (folder == null) {
				unsupported(DAILY + "folder", value, "dailyNotes.folder", this.dailyFolder,
						"Not a folder NotesApp can use");
				return;
			}
			String before = this.dailyFolder;
			this.dailyFolder = folder;
			row(DAILY + "folder", value, "dailyNotes.folder", before, folder, null);
		}

		void dailyTemplate(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			String template = folder(raw);
			if (template == null) {
				unsupported(DAILY + "template", value, "dailyNotes.template", this.dailyTemplate,
						"Not a path NotesApp can use");
				return;
			}
			// Obsidian names the template without ".md".
			if (!template.isEmpty() && !template.toLowerCase(Locale.ROOT).endsWith(".md")) {
				template = template + ".md";
			}
			String before = this.dailyTemplate;
			this.dailyTemplate = template;
			row(DAILY + "template", value, "dailyNotes.template", before, template, null);
		}

		void dailyAutorun(@Nullable JsonNode value) {
			if (!isBool(value)) {
				return;
			}
			String before = String.valueOf(this.openOnStartup);
			this.openOnStartup = value.booleanValue();
			row(DAILY + "autorun", value, "dailyNotes.openOnStartup", before, String.valueOf(this.openOnStartup),
					null);
		}

		void templatesFolder(@Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			String folder = folder(raw);
			if (folder == null) {
				unsupported(TEMPLATES + "folder", value, "templates.folder", this.templatesFolder,
						"Not a folder NotesApp can use");
				return;
			}
			String before = this.templatesFolder;
			this.templatesFolder = folder;
			row(TEMPLATES + "folder", value, "templates.folder", before, folder, null);
		}

		void templatesFormat(String key, @Nullable JsonNode value) {
			String raw = text(value);
			if (raw == null) {
				return;
			}
			boolean date = key.equals("dateFormat");
			String fallback = date ? "YYYY-MM-DD" : "HH:mm";
			String format = raw.isBlank() ? fallback : format(raw);
			String setting = "templates." + key;
			String before = date ? this.dateFormat : this.timeFormat;
			if (format == null) {
				unsupported(TEMPLATES + key, value, setting, before, "Too long");
				return;
			}
			if (date) {
				this.dateFormat = format;
			}
			else {
				this.timeFormat = format;
			}
			row(TEMPLATES + key, value, setting, before, format, null);
		}

	}

}
