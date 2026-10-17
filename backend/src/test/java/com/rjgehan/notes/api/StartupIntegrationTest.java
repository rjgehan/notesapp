package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.RunningApp;
import com.rjgehan.notes.vault.VaultFs;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Startup (DESIGN §8.1 integration item 12): the welcome note on a first run only, and the bootstrap commit for a
 * fresh, an imported and a changed-while-stopped vault; also read-only settings and a relative vault directory. Each
 * scenario boots the real application, on a random port, once or twice against the same vault, so these tests start
 * the application themselves.
 */
class StartupIntegrationTest {

	@TempDir
	Path vault;

	private static List<JsonNode> history(Api api, String path) {
		List<JsonNode> entries = new ArrayList<>();
		api.get("/api/history?path=" + Api.enc(path)).ok(200).get("entries").forEach(entries::add);
		return entries;
	}

	@Test
	void aFreshVaultGetsTheWelcomeNoteAndAnInitialCommitButNeverAgain() throws Exception {
		try (RunningApp app = RunningApp.start(this.vault)) {
			assertThat(Files.exists(this.vault.resolve("Welcome.md"))).isTrue();
			assertThat(Files.exists(this.vault.resolve(".notesapp/settings.json"))).isTrue();
			Api api = app.api();
			assertThat(api.get("/readyz").ok(200).get("status").asString()).isEqualTo("UP");
			JsonNode tree = api.get("/api/tree").ok(200);
			assertThat(tree.get("files").values().stream().map((f) -> f.get("path").asString())).containsExactly("Welcome.md");
			assertThat(tree.get("folders").isEmpty()).isTrue();
			assertThat(api.get("/api/files?path=Welcome.md").ok(200).get("content").asString()).contains("[[");

			app.awaitGitBootstrap();
			JsonNode first = history(api, "Welcome.md").get(0);
			assertThat(first.get("message").asString()).isEqualTo("Initial commit");
			assertThat(first.get("authorName").asString()).isEqualTo("NotesApp");
			assertThat(first.get("change").asString()).isEqualTo("added");
			assertThat(api.get("/api/status").ok(200).get("git").get("state").asString()).isEqualTo("ready");
		}

		Files.delete(this.vault.resolve("Welcome.md"));
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			assertThat(Files.exists(this.vault.resolve("Welcome.md"))).isFalse();
			Api api = app.api();
			assertThat(api.get("/api/tree").ok(200).get("files").isEmpty()).isTrue();
			JsonNode deleted = history(api, "Welcome.md").get(0);
			assertThat(deleted.get("message").asString()).isEqualTo("Changes made while NotesApp was stopped");
			assertThat(deleted.get("change").asString()).isEqualTo("deleted");
			assertThat(deleted.get("authorName").asString()).isEqualTo("External");
		}
	}

	@Test
	void aRelativeVaultDirectoryResolvesAgainstTheWorkingDirectory() {
		// Like the dev profile's ../dev-vault: a relative path with ".." segments.
		Path relative = Path.of("").toAbsolutePath().relativize(this.vault.resolve("relative"));
		assertThat(relative.toString()).startsWith("..");
		try (RunningApp app = RunningApp.start(this.vault, Map.of("notes.vault-dir", relative.toString()))) {
			assertThat(app.bean(VaultFs.class).root())
				.isEqualTo(this.vault.resolve("relative").toAbsolutePath().normalize());
			assertThat(Files.exists(this.vault.resolve("relative/Welcome.md"))).isTrue();
			app.awaitGitBootstrap();
		}
	}

	@Test
	void anExistingVaultIsImportedWithoutAWelcomeNote() throws Exception {
		Files.createDirectories(this.vault.resolve("Projects"));
		Files.writeString(this.vault.resolve("Projects/Plan.md"), "# Plan\n");
		Files.writeString(this.vault.resolve("Inbox.md"), "[[Plan]]\n");
		Files.createDirectories(this.vault.resolve(".obsidian"));
		Files.writeString(this.vault.resolve(".obsidian/app.json"), "{}");
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			assertThat(Files.exists(this.vault.resolve("Welcome.md"))).isFalse();
			Api api = app.api();
			assertThat(api.get("/api/tree").ok(200).get("files").size()).isEqualTo(2);
			JsonNode imported = history(api, "Projects/Plan.md").get(0);
			assertThat(imported.get("message").asString()).matches("Import existing vault \\(\\d+ files\\)");
			assertThat(imported.get("authorName").asString()).isEqualTo("NotesApp");
			assertThat(api.get("/api/notes/backlinks?path=" + Api.enc("Projects/Plan.md")).ok(200).get("linked").get(0)
				.get("source").asString()).isEqualTo("Inbox.md");
			JsonNode status = api.get("/api/status").ok(200);
			assertThat(status.get("vault").get("notes").asInt()).isEqualTo(2);
			assertThat(status.get("index").get("builtInMs").asLong()).isNotNegative();
		}
	}

	@Test
	void changesMadeWhileStoppedAreCommittedAsExternal() throws Exception {
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			app.api().postJson("/api/files", Map.of("path", "Journal.md", "content", "day one\n")).ok(201);
		}
		Files.writeString(this.vault.resolve("Journal.md"), "edited over SSH\n");
		Files.writeString(this.vault.resolve("Added.md"), "new\n");
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			Api api = app.api();
			List<JsonNode> journal = history(api, "Journal.md");
			assertThat(journal.get(0).get("message").asString()).isEqualTo("Changes made while NotesApp was stopped");
			assertThat(journal.get(0).get("authorName").asString()).isEqualTo("External");
			assertThat(journal.get(0).get("change").asString()).isEqualTo("modified");
			assertThat(journal.get(1).get("message").asString()).isEqualTo("Create Journal.md");
			assertThat(api.get("/api/files?path=Journal.md").ok(200).get("content").asString())
				.isEqualTo("edited over SSH\n");
			assertThat(history(api, "Added.md").get(0).get("commitId").asString())
				.isEqualTo(journal.get(0).get("commitId").asString());
		}
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			assertThat(history(app.api(), "Journal.md").get(0).get("message").asString())
				.isEqualTo("Changes made while NotesApp was stopped");
			assertThat(history(app.api(), "Journal.md")).hasSize(2);
		}
	}

	@Test
	void settingsFromANewerVersionAreReadOnlyAndNeverRewritten() throws Exception {
		Files.createDirectories(this.vault.resolve(".notesapp"));
		Path file = this.vault.resolve(".notesapp/settings.json");
		String newer = """
				{
				  "schemaVersion": 2,
				  "files": { "newLinkFormat": "relative", "futureOption": 7 },
				  "editor": { "defaultMode": "read" }
				}
				""";
		Files.writeString(file, newer);
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			Api api = app.api();
			JsonNode settings = api.get("/api/settings").ok(200);
			assertThat(settings.get("readOnly").asBoolean()).isTrue();
			assertThat(settings.get("settings").get("files").get("newLinkFormat").asString()).isEqualTo("relative");
			assertThat(settings.get("settings").get("editor").get("defaultMode").asString()).isEqualTo("read");
			assertThat(settings.get("settings").get("dailyNotes").get("folder").asString()).isEqualTo("Daily");
			JsonNode status = api.get("/api/status").ok(200).get("settings");
			assertThat(status.get("readOnly").asBoolean()).isTrue();
			assertThat(status.get("reason").asString()).isNotBlank();

			ObjectNode body = (ObjectNode) settings.get("settings").deepCopy();
			body.put("schemaVersion", 1);
			Api.Reply refused = api.putJson("/api/settings",
					Map.of("settings", body, "baseVersion", settings.get("version").asString()));
			assertThat(refused.problem(409)).isEqualTo("settings-read-only");
			assertThat(refused.json().get("title").asString()).isEqualTo("Settings are read-only");
			assertThat(refused.json().get("reason").asString()).isNotBlank();
		}
		assertThat(Files.readString(file, StandardCharsets.UTF_8)).isEqualTo(newer);
	}

}
