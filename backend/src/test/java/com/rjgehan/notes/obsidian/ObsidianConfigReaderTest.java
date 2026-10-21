package com.rjgehan.notes.obsidian;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/** Reading {@code .obsidian/} (ROADMAP item 24): what is read, and what is tolerated. */
class ObsidianConfigReaderTest {

	@TempDir
	Path vault;

	private ObsidianConfig read() {
		return new ObsidianConfigReader(null, ObsidianFixture.JSON).read(this.vault);
	}

	private void write(String path, String content) throws Exception {
		Path file = this.vault.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	@Test
	void readsTheFixtureVault() {
		ObsidianConfig config = ObsidianFixture.config();
		assertThat(config.found()).isTrue();
		assertThat(config.files()).containsExactly("app.json", "daily-notes.json", "templates.json", "graph.json",
				"core-plugins.json", "community-plugins.json");
		assertThat(config.problems()).isEmpty();
		assertThat(config.app().get("attachmentFolderPath").asString()).isEqualTo("./assets");
		assertThat(config.corePlugins()).containsEntry("graph", true).containsEntry("sync", false);
		// Names come from the plugin's manifest, then from what NotesApp knows, then the id.
		assertThat(config.communityPlugins()).containsExactly(Map.entry("dataview", "Dataview"),
				Map.entry("templater-obsidian", "Templater"), Map.entry("obsidian-kanban", "Kanban"),
				Map.entry("some-unknown-plugin", "some-unknown-plugin"));
	}

	@Test
	void aVaultWithoutObsidianHasNoConfig() throws Exception {
		assertThat(read()).isEqualTo(ObsidianConfig.NONE);
		write(".obsidian", "a file, not a folder");
		assertThat(read().found()).isFalse();
	}

	@Test
	void reportsUnreadableFilesAndAcceptsOldFormats() throws Exception {
		write(".obsidian/app.json", "{ not json");
		write(".obsidian/daily-notes.json", "[1, 2]");
		write(".obsidian/core-plugins.json", "[\"graph\", \"backlink\", 3]");
		write(".obsidian/community-plugins.json", "[\"../escape\", \"ok-plugin\", 7, \".hidden\"]");
		write(".obsidian/templates.json", "﻿{\"folder\": \"T\"}");
		write(".obsidian/graph.json", "{\"pad\": \"" + "x".repeat((int) ObsidianConfigReader.MAX_FILE_SIZE) + "\"}");
		ObsidianConfig config = read();
		assertThat(config.found()).isTrue();
		assertThat(config.app()).isNull();
		assertThat(config.dailyNotes()).isNull();
		assertThat(config.graph()).isNull();
		assertThat(config.templates().get("folder").asString()).isEqualTo("T");
		assertThat(config.problems()).containsExactly("app.json is not valid JSON",
				"daily-notes.json is not a JSON object", "graph.json is larger than 1 MB");
		assertThat(config.corePlugins()).containsOnlyKeys("graph", "backlink");
		assertThat(config.communityPlugins()).containsOnlyKeys("ok-plugin");
	}

	@Test
	void fallsBackToTheCorePluginMigrationFile() throws Exception {
		write(".obsidian/core-plugins-migration.json", "{\"graph\": false, \"outline\": true}");
		assertThat(read().corePlugins()).containsEntry("graph", false).containsEntry("outline", true);
	}

}
