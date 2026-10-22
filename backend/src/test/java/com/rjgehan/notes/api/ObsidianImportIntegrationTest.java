package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.RunningApp;
import com.rjgehan.notes.vault.Hashing;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Importing an Obsidian vault (ROADMAP item 24) with the fixture of {@code src/test/resources/vaults/obsidian}: the
 * first start takes its settings from {@code .obsidian/}, leaves that folder untouched and out of the tree, keeps
 * {@code workspace.json} out of history, and {@code GET /api/compat} reports what NotesApp does not handle.
 */
class ObsidianImportIntegrationTest {

	private static final Path FIXTURE = Path.of("src/test/resources/vaults/obsidian").toAbsolutePath();

	@TempDir
	Path vault;

	private void copyFixture() throws IOException {
		try (Stream<Path> walk = Files.walk(FIXTURE)) {
			for (Path source : walk.toList()) {
				Path target = this.vault.resolve(FIXTURE.relativize(source).toString());
				if (Files.isDirectory(source)) {
					Files.createDirectories(target);
				}
				else {
					Files.copy(source, target);
				}
			}
		}
	}

	private Map<String, String> obsidianHashes() throws IOException {
		Map<String, String> hashes = new HashMap<>();
		try (Stream<Path> walk = Files.walk(this.vault.resolve(".obsidian"))) {
			for (Path file : walk.filter(Files::isRegularFile).toList()) {
				hashes.put(this.vault.relativize(file).toString(), Hashing.blobId(Files.readAllBytes(file)));
			}
		}
		return hashes;
	}

	private List<String> committedPaths() throws Exception {
		List<String> paths = new ArrayList<>();
		try (Git git = Git.open(this.vault.toFile()); Repository repo = git.getRepository();
				RevWalk walk = new RevWalk(repo); TreeWalk tree = new TreeWalk(repo)) {
			tree.addTree(walk.parseCommit(repo.resolve("HEAD")).getTree());
			tree.setRecursive(true);
			while (tree.next()) {
				paths.add(tree.getPathString());
			}
		}
		return paths;
	}

	private static Map<String, JsonNode> byId(JsonNode array, String key) {
		Map<String, JsonNode> map = new HashMap<>();
		array.forEach((item) -> map.put(item.get(key).asString(), item));
		return map;
	}

	@Test
	void aFirstStartTakesTheSettingsAndReportsWhatIsNotSupported() throws Exception {
		copyFixture();
		Map<String, String> before = obsidianHashes();
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			Api api = app.api();
			JsonNode settings = api.get("/api/settings").ok(200).get("settings");
			assertThat(settings.get("files").get("attachmentLocation").asString()).isEqualTo("subfolder");
			assertThat(settings.get("files").get("attachmentSubfolder").asString()).isEqualTo("assets");
			assertThat(settings.get("files").get("newLinkFormat").asString()).isEqualTo("relative");
			assertThat(settings.get("files").get("excludedPaths").get(0).asString()).isEqualTo("Archive");
			assertThat(settings.get("dailyNotes").get("folder").asString()).isEqualTo("Journal");
			assertThat(settings.get("dailyNotes").get("template").asString()).isEqualTo("Templates/Daily.md");
			assertThat(settings.get("templates").get("dateFormat").asString()).isEqualTo("DD.MM.YYYY");
			assertThat(settings.get("editor").get("defaultMode").asString()).isEqualTo("read");

			// .obsidian/ is hidden from the tree and never written; an imported vault gets no welcome note.
			JsonNode tree = api.get("/api/tree").ok(200);
			List<String> files = new ArrayList<>();
			tree.get("files").forEach((f) -> files.add(f.get("path").asString()));
			assertThat(files).contains("Home.md", "Projects/Plan.md", "assets/pic.png", "Map.canvas")
				.noneMatch((p) -> p.startsWith(".obsidian"))
				.doesNotContain("Welcome.md");
			assertThat(obsidianHashes()).isEqualTo(before);
			assertThat(api.get("/api/files?path=" + Api.enc(".obsidian/app.json")).problem(403))
				.isEqualTo("reserved-path");

			// Obsidian's settings are versioned with the vault, except its per-device workspace.
			List<String> committed = committedPaths();
			assertThat(committed).contains(".obsidian/app.json", ".notesapp/settings.json", "Home.md")
				.doesNotContain(".obsidian/workspace.json");

			JsonNode report = api.get("/api/compat").ok(200);
			assertThat(report.get("obsidian").get("found").asBoolean()).isTrue();
			assertThat(report.get("obsidian").get("configFiles").size()).isEqualTo(6);
			// Every setting is already applied.
			report.get("settings").forEach((row) -> assertThat(row.get("status").asString())
				.as(row.get("source").asString())
				.isIn("same", "unsupported"));
			assertThat(report.get("settingsVersion").asString())
				.isEqualTo(api.get("/api/settings").ok(200).get("version").asString());
			assertThat(report.get("proposedSettings")).isEqualTo(settings);
			assertThat(report.get("graph").get("showArrow").asBoolean()).isTrue();
			assertThat(report.get("graph").get("colorGroups").get(0).get("query").asString()).isEqualTo("tag:#project");
			assertThat(report.get("graph").has("scale")).isFalse();

			Map<String, JsonNode> plugins = byId(report.get("plugins"), "id");
			assertThat(plugins.get("dataview").get("status").asString()).isEqualTo("partial");
			assertThat(plugins.get("dataview").get("kind").asString()).isEqualTo("community");
			assertThat(plugins.get("some-unknown-plugin").get("status").asString()).isEqualTo("unknown");
			assertThat(plugins.get("graph").get("status").asString()).isEqualTo("supported");
			assertThat(plugins).doesNotContainKey("sync");

			Map<String, JsonNode> issues = byId(report.get("issues"), "id");
			assertThat(issues).doesNotContainKeys("callouts", "mermaid", "math");
			assertThat(issues).containsKeys("dataview", "templater", "missing-files",
					"missing-headings", "missing-blocks", "missing-notes", "frontmatter", "canvas");
			assertThat(issues).doesNotContainKey("kanban");
			JsonNode dataview = issues.get("dataview");
			assertThat(dataview.get("category").asString()).isEqualTo("syntax");
			assertThat(dataview.get("severity").asString()).isEqualTo("warning");
			// ```dataview queries run since ROADMAP item 17: only the inline query is left (Plan.md's TABLE runs).
			assertThat(dataview.path("roadmapItem").isIntegralNumber()).isFalse();
			assertThat(dataview.get("count").asInt()).isEqualTo(1);
			assertThat(dataview.get("truncated").asBoolean()).isFalse();
			assertThat(dataview.get("occurrences").get(0).get("path").asString()).isEqualTo("Home.md");
			assertThat(report.get("totals").get("notes").asInt()).isGreaterThanOrEqualTo(9);
			assertThat(report.get("totals").get("warnings").asInt()).isPositive();

			// Changing a setting afterwards shows up as a difference to apply again.
			JsonNode current = api.get("/api/settings").ok(200);
			ObjectNode changed = (ObjectNode) current.get("settings").deepCopy();
			((ObjectNode) changed.get("dailyNotes")).put("folder", "Daily");
			api.putJson("/api/settings", Map.of("settings", changed, "baseVersion", current.get("version").asString()))
				.ok(200);
			JsonNode after = api.get("/api/compat").ok(200);
			JsonNode folderRow = byId(after.get("settings"), "source").get("daily-notes.json › folder");
			assertThat(folderRow.get("status").asString()).isEqualTo("different");
			assertThat(folderRow.get("current").asString()).isEqualTo("Daily");
			assertThat(folderRow.get("proposed").asString()).isEqualTo("Journal");
		}

		// A later start keeps the settings file as it is: Obsidian's settings are only a first-run default.
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			assertThat(app.api().get("/api/settings").ok(200).get("settings").get("dailyNotes").get("folder").asString())
				.isEqualTo("Daily");
		}
		assertThat(obsidianHashes()).isEqualTo(before);
	}

	@Test
	void aVaultWithoutObsidianHasAReportToo() throws Exception {
		Files.writeString(this.vault.resolve("Note.md"), "[[Nowhere]]\n");
		try (RunningApp app = RunningApp.start(this.vault).awaitGitBootstrap()) {
			JsonNode report = app.api().get("/api/compat").ok(200);
			assertThat(report.get("obsidian").get("found").asBoolean()).isFalse();
			assertThat(report.get("settings").isEmpty()).isTrue();
			assertThat(report.get("proposedSettings").isNull()).isTrue();
			assertThat(report.get("graph").isNull()).isTrue();
			assertThat(report.get("plugins").isEmpty()).isTrue();
			assertThat(report.get("issues").get(0).get("id").asString()).isEqualTo("missing-notes");
			assertThat(app.api().get("/api/settings").ok(200).get("settings").get("dailyNotes").get("folder").asString())
				.isEqualTo("Daily");
		}
	}

}
