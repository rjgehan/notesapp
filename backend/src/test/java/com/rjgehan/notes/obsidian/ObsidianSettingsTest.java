package com.rjgehan.notes.obsidian;

import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.CompatSetting;
import com.rjgehan.notes.api.dto.CompatSetting.Status;
import com.rjgehan.notes.settings.AttachmentLocation;
import com.rjgehan.notes.settings.EditorMode;
import com.rjgehan.notes.settings.LinkFormat;
import com.rjgehan.notes.settings.NewNoteLocation;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

/** Obsidian's settings in NotesApp terms (ROADMAP item 24). */
class ObsidianSettingsTest {

	private static ObsidianConfig app(String json) {
		ObjectNode app = (ObjectNode) ObsidianFixture.JSON.readTree(json);
		return new ObsidianConfig(true, app, null, null, null, Map.of(), Map.of(), List.of("app.json"), List.of());
	}

	private static CompatSetting row(ObsidianSettings.Mapping mapping, String source) {
		return mapping.rows().stream().filter((r) -> r.source().equals(source)).findFirst().orElseThrow();
	}

	@Test
	void mapsTheFixtureVault() {
		ObsidianSettings.Mapping mapping = ObsidianSettings.map(ObsidianFixture.config(), Settings.defaults());
		Settings s = mapping.proposed();
		assertThat(SettingsService.validate(s)).isEmpty();
		assertThat(s.files().attachmentLocation()).isEqualTo(AttachmentLocation.SUBFOLDER);
		assertThat(s.files().attachmentSubfolder()).isEqualTo("assets");
		assertThat(s.files().newNoteLocation()).isEqualTo(NewNoteLocation.FOLDER);
		assertThat(s.files().newNoteFolder()).isEqualTo("Inbox");
		assertThat(s.files().newLinkFormat()).isEqualTo(LinkFormat.RELATIVE);
		assertThat(s.files().useWikilinks()).isTrue();
		assertThat(s.files().autoUpdateLinks()).isTrue();
		assertThat(s.files().excludedPaths()).containsExactly("Archive");
		assertThat(s.editor().strictLineBreaks()).isTrue();
		assertThat(s.editor().defaultMode()).isEqualTo(EditorMode.READ);
		assertThat(s.dailyNotes().format()).isEqualTo("YYYY/MM-DD");
		assertThat(s.dailyNotes().folder()).isEqualTo("Journal");
		assertThat(s.dailyNotes().template()).isEqualTo("Templates/Daily.md");
		assertThat(s.dailyNotes().openOnStartup()).isTrue();
		assertThat(s.templates().folder()).isEqualTo("Templates");
		assertThat(s.templates().dateFormat()).isEqualTo("DD.MM.YYYY");
		// Obsidian's empty time format is its default.
		assertThat(s.templates().timeFormat()).isEqualTo("HH:mm");

		CompatSetting attachments = row(mapping, "app.json › attachmentFolderPath");
		assertThat(attachments.status()).isEqualTo(Status.DIFFERENT);
		assertThat(attachments.current()).isEqualTo("folder Attachments");
		assertThat(attachments.proposed()).isEqualTo("subfolder assets next to the note");
		assertThat(attachments.obsidianValue()).isEqualTo("\"./assets\"");
		CompatSetting excluded = row(mapping, "app.json › userIgnoreFilters");
		assertThat(excluded.note()).contains("/^Private.*$/");
		assertThat(row(mapping, "templates.json › folder").status()).isEqualTo(Status.SAME);
		// Settings NotesApp does not have produce no row.
		assertThat(mapping.rows()).noneMatch((r) -> r.source().contains("showLineNumber"));

		// Applied once, the same config proposes nothing new.
		ObsidianSettings.Mapping again = ObsidianSettings.map(ObsidianFixture.config(), s);
		assertThat(again.proposed()).isEqualTo(s);
		assertThat(again.rows()).allMatch((r) -> r.status() != Status.DIFFERENT);
	}

	@Test
	void mapsEveryAttachmentLocation() {
		assertThat(ObsidianSettings.map(app("{\"attachmentFolderPath\": \"/\"}"), Settings.defaults())
			.proposed()
			.files()
			.attachmentLocation()).isEqualTo(AttachmentLocation.ROOT);
		assertThat(ObsidianSettings.map(app("{\"attachmentFolderPath\": \"./\"}"), Settings.defaults())
			.proposed()
			.files()
			.attachmentLocation()).isEqualTo(AttachmentLocation.CURRENT);
		Settings folder = ObsidianSettings
			.map(app("{\"attachmentFolderPath\": \"Files/Media/\"}"), Settings.defaults())
			.proposed();
		assertThat(folder.files().attachmentLocation()).isEqualTo(AttachmentLocation.FOLDER);
		assertThat(folder.files().attachmentFolder()).isEqualTo("Files/Media");
		ObsidianSettings.Mapping nested = ObsidianSettings.map(app("{\"attachmentFolderPath\": \"./a/b\"}"),
				Settings.defaults());
		assertThat(nested.proposed()).isEqualTo(Settings.defaults());
		assertThat(nested.rows().get(0).status()).isEqualTo(Status.UNSUPPORTED);
		ObsidianSettings.Mapping hidden = ObsidianSettings.map(app("{\"attachmentFolderPath\": \".hidden\"}"),
				Settings.defaults());
		assertThat(hidden.proposed()).isEqualTo(Settings.defaults());
		assertThat(hidden.rows().get(0).status()).isEqualTo(Status.UNSUPPORTED);
	}

	@Test
	void ignoresWhatItCannotUse() {
		ObsidianSettings.Mapping mapping = ObsidianSettings.map(app("""
				{"newFileLocation": "folder", "newFileFolderPath": "", "newLinkFormat": "weird",
				 "useMarkdownLinks": true, "alwaysUpdateLinks": false, "defaultViewMode": 3,
				 "userIgnoreFilters": ["", "/regex/", "ok/"]}
				"""), Settings.defaults());
		Settings s = mapping.proposed();
		// "folder" with an empty path is the vault root.
		assertThat(s.files().newNoteLocation()).isEqualTo(NewNoteLocation.ROOT);
		assertThat(s.files().newLinkFormat()).isEqualTo(LinkFormat.SHORTEST);
		assertThat(s.files().useWikilinks()).isFalse();
		assertThat(s.files().autoUpdateLinks()).isTrue();
		assertThat(s.files().excludedPaths()).containsExactly("ok");
		assertThat(row(mapping, "app.json › newLinkFormat").status()).isEqualTo(Status.UNSUPPORTED);
		assertThat(row(mapping, "app.json › alwaysUpdateLinks").status()).isEqualTo(Status.SAME);
		assertThat(mapping.rows()).noneMatch((r) -> r.source().endsWith("defaultViewMode"));
	}

	@Test
	void seedsAFirstRunOnlyWhenTheVaultHasObsidianSettings() {
		ObsidianConfigReader fixture = new ObsidianConfigReader(null, ObsidianFixture.JSON) {
			@Override
			public ObsidianConfig read() {
				return ObsidianFixture.config();
			}
		};
		assertThat(new ObsidianSettings(fixture).firstRun(Settings.defaults()).dailyNotes().folder())
			.isEqualTo("Journal");
		ObsidianConfigReader none = new ObsidianConfigReader(null, ObsidianFixture.JSON) {
			@Override
			public ObsidianConfig read() {
				return ObsidianConfig.NONE;
			}
		};
		assertThat(new ObsidianSettings(none).firstRun(Settings.defaults())).isEqualTo(Settings.defaults());
	}

}
