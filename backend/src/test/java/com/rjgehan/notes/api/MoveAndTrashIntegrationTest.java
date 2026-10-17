package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.SseRecorder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Move with link updates, and delete, restore, purge and empty through the trash (DESIGN §8.1 integration items 6
 * and 7), including the commits and the events other clients receive. Batches never commit on their own here, so
 * every commit, and every {@code history.committed}, comes from the request that the test makes.
 */
@NotesIntegrationTest
class MoveAndTrashIntegrationTest {

	private static final String OBSERVER = "observer-client-01";

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.git.commit-quiet-period", "1h", "notes.git.commit-max-delay", "1h"));
	}

	@LocalServerPort
	int port;

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private JsonNode create(String path, String content) {
		return this.api.postJson("/api/files", Map.of("path", path, "content", content)).ok(201);
	}

	private String read(String path) {
		return this.api.get("/api/files?path=" + Api.enc(path)).ok(200).get("content").asString();
	}

	private List<JsonNode> history(String path) {
		List<JsonNode> entries = new ArrayList<>();
		this.api.get("/api/history?path=" + Api.enc(path)).ok(200).get("entries").forEach(entries::add);
		return entries;
	}

	private JsonNode resolve(String source, String target) {
		return this.api.postJson("/api/links/resolve", Map.of("source", source, "targets", List.of(target)))
			.ok(200)
			.get("resolved")
			.get(target);
	}

	private JsonNode data(SseRecorder events, String name) {
		return events.frames()
			.stream()
			.filter((frame) -> frame.event().equals(name))
			.reduce((first, second) -> second)
			.orElseThrow()
			.data();
	}

	// ---------------------------------------------------------------- item 6: move

	@Test
	void aMoveRewritesLinksInTwoCommitsAndTellsOtherClients() {
		String version = create("Move/Target.md", "# Target\n").get("file").get("version").asString();
		create("Move/Linker.md", "See [[Target]], [[Target#Heading|it]] and [t](Target.md).\n```\n[[Target]]\n```\n");
		this.api.postEmpty("/api/history/commit").ok(200);

		JsonNode dry = this.api.postJson("/api/move",
				Map.of("from", "Move/Target.md", "to", "Archive/2026/Renamed.md", "dryRun", true))
			.ok(200);
		assertThat(dry.get("dryRun").asBoolean()).isTrue();
		assertThat(dry.get("createdFolders").isEmpty()).isTrue();
		assertThat(dry.get("commitId").isNull()).isTrue();
		assertThat(dry.get("linkUpdates").get(0).get("path").asString()).isEqualTo("Move/Linker.md");
		assertThat(dry.get("linkUpdates").get(0).get("links").asInt()).isEqualTo(3);
		assertThat(dry.get("linkUpdates").get(0).get("version").isNull()).isTrue();
		assertThat(read("Move/Linker.md")).startsWith("See [[Target]]");
		assertThat(Files.exists(vault.resolve("Archive"))).isFalse();

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null);
				SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			JsonNode result = this.api.postJson("/api/move", Map.of("from", "Move/Target.md", "to",
					"Archive/2026/Renamed.md")).ok(200);
			assertThat(result.get("dryRun").asBoolean()).isFalse();
			assertThat(result.get("type").asString()).isEqualTo("file");
			assertThat(result.get("from").asString()).isEqualTo("Move/Target.md");
			assertThat(result.get("to").asString()).isEqualTo("Archive/2026/Renamed.md");
			assertThat(result.get("moved").get(0).get("from").asString()).isEqualTo("Move/Target.md");
			assertThat(result.get("moved").get(0).get("to").asString()).isEqualTo("Archive/2026/Renamed.md");
			assertThat(result.get("createdFolders").values().stream().map(JsonNode::asString))
				.containsExactly("Archive", "Archive/2026");
			JsonNode update = result.get("linkUpdates").get(0);
			assertThat(update.get("path").asString()).isEqualTo("Move/Linker.md");
			assertThat(update.get("links").asInt()).isEqualTo(3);
			assertThat(result.get("failed").isEmpty()).isTrue();
			String linker = read("Move/Linker.md");
			assertThat(linker).isEqualTo(
					"See [[Renamed]], [[Renamed#Heading|it]] and [t](Renamed.md).\n```\n[[Target]]\n```\n");
			assertThat(update.get("version").asString())
				.isEqualTo(this.api.get("/api/files?path=" + Api.enc("Move/Linker.md")).json().get("version").asString());

			List<JsonNode> renamed = history("Archive/2026/Renamed.md");
			assertThat(renamed.get(0).get("message").asString())
				.isEqualTo("Move Move/Target.md → Archive/2026/Renamed.md");
			assertThat(renamed.get(0).get("change").asString()).isEqualTo("renamed");
			assertThat(renamed.get(0).get("renamedFrom").asString()).isEqualTo("Move/Target.md");
			assertThat(renamed.get(1).get("path").asString()).isEqualTo("Move/Target.md");
			JsonNode links = history("Move/Linker.md").get(0);
			assertThat(links.get("message").asString())
				.isEqualTo("Update links after moving Move/Target.md → Archive/2026/Renamed.md (1 note)");
			assertThat(result.get("commitId").asString()).isEqualTo(links.get("commitId").asString());
			assertThat(links.get("parentCommitId").asString()).isEqualTo(renamed.get(0).get("commitId").asString());

			others.awaitFrames((frames) -> frames.stream().filter((f) -> f.event().equals("history.committed")).count() == 2);
			assertThat(others.eventNames()).containsExactly("folder.created", "folder.created", "entry.moved",
					"file.changed", "history.committed", "history.committed");
			JsonNode moved = data(others, "entry.moved");
			assertThat(moved.get("from").asString()).isEqualTo("Move/Target.md");
			assertThat(moved.get("to").asString()).isEqualTo("Archive/2026/Renamed.md");
			assertThat(moved.get("type").asString()).isEqualTo("file");
			assertThat(moved.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			JsonNode committed = data(others, "history.committed");
			assertThat(committed.get("commitId").asString()).isEqualTo(result.get("commitId").asString());
			assertThat(committed.get("paths").values().stream().map(JsonNode::asString)).containsExactly("Move/Linker.md");
			assertThat(committed.get("truncated").asBoolean()).isFalse();
			assertThat(committed.get("authorName").asString()).isEqualTo("Owner");
			assertThat(committed.has("origin")).isFalse();
			mine.awaitFrames((frames) -> frames.stream().filter((f) -> f.event().equals("history.committed")).count() == 2);
			assertThat(mine.eventNames()).containsExactly("history.committed", "history.committed");
		}

		Map<String, Object> stale = new HashMap<>();
		stale.put("content", "mine");
		stale.put("baseVersion", version);
		Reply conflict = this.api.putJson("/api/files?path=" + Api.enc("Move/Target.md"), stale);
		assertThat(conflict.problem(409)).isEqualTo("version-conflict");
		assertThat(conflict.json().get("movedTo").asString()).isEqualTo("Archive/2026/Renamed.md");
		Reply followed = this.api.putJson("/api/files?path=" + Api.enc("Archive/2026/Renamed.md"), stale);
		assertThat(followed.status()).isEqualTo(200);
	}

	@Test
	void foldersCaseOnlyRenamesAndErrors() {
		create("Tree/Sub/a.md", "[[b]]\n");
		create("Tree/Sub/Deep/b.md", "");
		create("Tree/Outside.md", "[[Tree/Sub/a]]\n");
		create("Tree/case.md", "");
		create("Tree/Blocker.md", "");

		JsonNode folder = this.api.postJson("/api/move", Map.of("from", "Tree/Sub", "to", "Tree/Moved")).ok(200);
		assertThat(folder.get("type").asString()).isEqualTo("folder");
		assertThat(folder.get("moved").values().stream().map((m) -> m.get("to").asString()))
			.containsExactlyInAnyOrder("Tree/Moved/a.md", "Tree/Moved/Deep/b.md");
		assertThat(read("Tree/Outside.md")).isEqualTo("[[a]]\n");
		assertThat(this.api.get("/api/tree").json().get("folders").values().stream().map((f) -> f.get("path").asString()))
			.contains("Tree/Moved", "Tree/Moved/Deep")
			.doesNotContain("Tree/Sub");

		JsonNode caseOnly = this.api.postJson("/api/move", Map.of("from", "Tree/case.md", "to", "Tree/Case.md")).ok(200);
		assertThat(caseOnly.get("to").asString()).isEqualTo("Tree/Case.md");
		assertThat(history("Tree/Case.md").get(0).get("message").asString())
			.isEqualTo("Rename Tree/case.md → Tree/Case.md");

		JsonNode noLinks = this.api
			.postJson("/api/move", Map.of("from", "Tree/Moved/a.md", "to", "Tree/Moved/A2.md", "updateLinks", false))
			.ok(200);
		assertThat(noLinks.get("linkUpdates").isEmpty()).isTrue();
		assertThat(read("Tree/Outside.md")).isEqualTo("[[a]]\n");
		assertThat(resolve("Tree/Outside.md", "a").get("path").isNull()).isTrue();

		Reply intoSelf = this.api.postJson("/api/move", Map.of("from", "Tree", "to", "Tree/Moved/Inner"));
		assertThat(intoSelf.problem(400)).isEqualTo("move-into-self");
		assertThat(intoSelf.json().get("title").asString()).isEqualTo("Cannot move a folder into itself");
		assertThat(intoSelf.json().get("from").asString()).isEqualTo("Tree");
		assertThat(intoSelf.json().get("to").asString()).isEqualTo("Tree/Moved/Inner");
		assertThat(this.api.postJson("/api/move", Map.of("from", "Tree/Case.md", "to", "Tree/Blocker.md")).problem(409))
			.isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/move", Map.of("from", "Tree/Case.md", "to", "Tree/blocker.md")).problem(409))
			.isEqualTo("case-collision");
		Reply parentIsFile = this.api.postJson("/api/move", Map.of("from", "Tree/Case.md", "to", "Tree/Blocker.md/x.md"));
		assertThat(parentIsFile.problem(409)).isEqualTo("type-mismatch");
		assertThat(this.api.postJson("/api/move", Map.of("from", "Tree/None.md", "to", "Tree/x.md")).problem(404))
			.isEqualTo("not-found");
		assertThat(this.api.postJson("/api/move", Map.of("from", "Tree/Case.md", "to", "Tree/Bad|name.md")).problem(400))
			.isEqualTo("invalid-name");
	}

	// ---------------------------------------------------------------- item 7: trash

	@Test
	void deleteToTrashAndRestoreBringBackTheLinks() {
		create("Bin/Plan.md", "# Plan\n");
		create("Bin/Linker.md", "[[Plan]]\n");
		this.api.postEmpty("/api/history/commit").ok(200);
		assertThat(resolve("Bin/Linker.md", "Plan").get("path").asString()).isEqualTo("Bin/Plan.md");

		JsonNode deleted;
		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null);
				SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			deleted = this.api.delete("/api/files?path=" + Api.enc("Bin/Plan.md")).ok(200);
			assertThat(deleted.get("id").asString()).matches("[0-9A-HJKMNP-TV-Z]{12}");
			assertThat(deleted.get("originalPath").asString()).isEqualTo("Bin/Plan.md");
			assertThat(deleted.get("type").asString()).isEqualTo("file");
			assertThat(deleted.get("deletedAt").asString()).matches(".*T.*\\.\\d{3}Z");
			assertThat(deleted.get("deletedBy").asString()).isEqualTo("owner@notes");
			assertThat(deleted.get("size").asLong()).isEqualTo(7);
			assertThat(deleted.get("fileCount").asInt()).isEqualTo(1);
			assertThat(others.awaitEvent("history.committed")).containsExactly("file.deleted", "trash.changed",
					"history.committed");
			JsonNode event = data(others, "file.deleted");
			assertThat(event.get("path").asString()).isEqualTo("Bin/Plan.md");
			assertThat(event.get("trashed").asBoolean()).isTrue();
			assertThat(event.get("trashId").asString()).isEqualTo(deleted.get("id").asString());
			assertThat(data(others, "trash.changed").isEmpty()).isTrue();
			assertThat(mine.awaitEvent("history.committed")).containsExactly("trash.changed", "history.committed");
		}
		String id = deleted.get("id").asString();
		assertThat(Files.exists(vault.resolve(".trash/Plan.md"))).isTrue();
		assertThat(resolve("Bin/Linker.md", "Plan").get("path").isNull()).isTrue();
		assertThat(history("Bin/Plan.md").get(0).get("message").asString()).isEqualTo("Delete Bin/Plan.md");
		assertThat(history("Bin/Plan.md").get(0).get("change").asString()).isEqualTo("deleted");

		JsonNode listed = this.api.get("/api/trash").ok(200).get("entries").get(0);
		assertThat(listed).isEqualTo(deleted);
		Reply raw = this.api.get("/api/trash/" + id + "/raw");
		assertThat(raw.status()).isEqualTo(200);
		assertThat(raw.text()).isEqualTo("# Plan\n");
		assertThat(raw.header("Content-Security-Policy")).startsWith("sandbox;");
		assertThat(raw.header("X-Content-Type-Options")).isEqualTo("nosniff");

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			JsonNode restored = this.api.postEmpty("/api/trash/" + id + "/restore").ok(200);
			assertThat(restored.get("type").asString()).isEqualTo("file");
			assertThat(restored.get("path").asString()).isEqualTo("Bin/Plan.md");
			assertThat(restored.get("files").get(0).get("path").asString()).isEqualTo("Bin/Plan.md");
			assertThat(restored.get("createdFolders").isEmpty()).isTrue();
			assertThat(restored.get("commitId").asString()).matches("[0-9a-f]{40}");
			assertThat(others.awaitEvent("history.committed")).containsExactly("file.created", "trash.changed",
					"history.committed");
		}
		assertThat(resolve("Bin/Linker.md", "Plan").get("path").asString()).isEqualTo("Bin/Plan.md");
		assertThat(history("Bin/Plan.md").stream().map((e) -> e.get("message").asString()))
			.startsWith("Restore Bin/Plan.md from trash", "Delete Bin/Plan.md");
		assertThat(this.api.get("/api/trash").json().get("entries").values())
			.noneMatch((entry) -> entry.get("id").asString().equals(id));
		assertThat(this.api.postEmpty("/api/trash/" + id + "/restore").problem(404)).isEqualTo("not-found");
	}

	@Test
	void foldersGoToTheTrashAsOneEntry() {
		create("Gone/One.md", "1");
		create("Gone/Sub/Two.md", "22");
		this.api.postJson("/api/folders", Map.of("path", "Gone/Empty")).ok(201);
		JsonNode folder;
		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			folder = this.api.delete("/api/folders?path=Gone").ok(200);
			assertThat(folder.get("type").asString()).isEqualTo("folder");
			assertThat(folder.get("fileCount").asInt()).isEqualTo(2);
			assertThat(folder.get("size").asLong()).isEqualTo(3);
			// The new files were still pending: they are committed first, and both commits follow the content events.
			others.awaitFrames((frames) -> frames.stream().filter((f) -> f.event().equals("history.committed")).count() == 2);
			assertThat(others.eventNames()).containsExactly("folder.deleted", "trash.changed", "history.committed",
					"history.committed");
			assertThat(data(others, "folder.deleted").get("trashId").asString()).isEqualTo(folder.get("id").asString());
			assertThat(data(others, "folder.deleted").get("trashed").asBoolean()).isTrue();
			assertThat(data(others, "history.committed").get("message").asString())
				.isEqualTo("Delete folder Gone (2 files)");
		}
		List<JsonNode> two = history("Gone/Sub/Two.md");
		assertThat(two.get(0).get("message").asString()).isEqualTo("Delete folder Gone (2 files)");
		assertThat(two.get(1).get("change").asString()).isEqualTo("added");
		assertThat(this.api.get("/api/trash/" + folder.get("id").asString() + "/raw").problem(409))
			.isEqualTo("type-mismatch");

		this.api.postJson("/api/folders", Map.of("path", "Hollow")).ok(201);
		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			this.api.delete("/api/folders?path=Hollow").ok(200);
			others.awaitEvent("trash.changed");
			create("Marker.md", "");
			others.awaitEvent("file.created");
			assertThat(others.eventNames()).containsExactly("folder.deleted", "trash.changed", "file.created");
		}

		JsonNode restored = this.api.postEmpty("/api/trash/" + folder.get("id").asString() + "/restore").ok(200);
		assertThat(restored.get("type").asString()).isEqualTo("folder");
		assertThat(restored.get("files").values().stream().map((f) -> f.get("path").asString()))
			.containsExactlyInAnyOrder("Gone/One.md", "Gone/Sub/Two.md");
		assertThat(restored.get("createdFolders").values().stream().map(JsonNode::asString))
			.containsExactly("Gone", "Gone/Empty", "Gone/Sub");
		assertThat(read("Gone/Sub/Two.md")).isEqualTo("22");
	}

	@Test
	void restoreConflictsRenameAndExplicitTargets() {
		create("Again/Note.md", "first");
		String first = this.api.delete("/api/files?path=" + Api.enc("Again/Note.md")).ok(200).get("id").asString();
		create("Again/Note.md", "second");
		Reply conflict = this.api.postEmpty("/api/trash/" + first + "/restore");
		assertThat(conflict.problem(409)).isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/trash/" + first + "/restore", Map.of("to", "Again/Bad#name.md")).problem(400))
			.isEqualTo("invalid-name");
		JsonNode renamed = this.api.postJson("/api/trash/" + first + "/restore", Map.of("onConflict", "rename")).ok(200);
		assertThat(renamed.get("path").asString()).isEqualTo("Again/Note 1.md");
		assertThat(read("Again/Note 1.md")).isEqualTo("first");

		String second = this.api.delete("/api/files?path=" + Api.enc("Again/Note.md")).ok(200).get("id").asString();
		JsonNode explicit = this.api.postJson("/api/trash/" + second + "/restore", Map.of("to", "elsewhere/Copy.md"))
			.ok(200);
		assertThat(explicit.get("path").asString()).isEqualTo("elsewhere/Copy.md");
		assertThat(explicit.get("createdFolders").values().stream().map(JsonNode::asString)).containsExactly("elsewhere");
		assertThat(this.api.postJson("/api/trash/" + second + "/restore", "{}").problem(404)).isEqualTo("not-found");
	}

	@Test
	void purgeEmptyAndExternalTrashItems() throws Exception {
		create("Scrap/A.md", "a");
		create("Scrap/B.md", "b");
		String a = this.api.delete("/api/files?path=" + Api.enc("Scrap/A.md")).ok(200).get("id").asString();
		this.api.delete("/api/files?path=" + Api.enc("Scrap/B.md")).ok(200);
		Files.createDirectories(vault.resolve(".trash"));
		Files.writeString(vault.resolve(".trash/From Obsidian.md"), "by hand");

		JsonNode external = this.api.get("/api/trash")
			.ok(200)
			.get("entries")
			.values()
			.stream()
			.filter((entry) -> entry.get("originalPath").asString().equals("From Obsidian.md"))
			.findFirst()
			.orElseThrow();
		assertThat(external.get("id").asString()).matches("x-[0-9a-f]{16}");
		assertThat(external.get("deletedBy").asString()).isEqualTo("unknown");
		assertThat(external.get("type").asString()).isEqualTo("file");
		assertThat(this.api.get("/api/trash/" + external.get("id").asString() + "/raw").text()).isEqualTo("by hand");

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			Reply purged = this.api.delete("/api/trash/" + a);
			assertThat(purged.status()).isEqualTo(204);
			assertThat(purged.body()).isEmpty();
			assertThat(others.awaitEvent("trash.changed")).containsExactly("trash.changed");
		}
		assertThat(this.api.delete("/api/trash/" + a).problem(404)).isEqualTo("not-found");
		assertThat(this.api.get("/api/trash/" + a + "/raw").problem(404)).isEqualTo("not-found");

		int remaining = this.api.get("/api/trash").json().get("entries").size();
		JsonNode emptied = this.api.delete("/api/trash").ok(200);
		assertThat(emptied.get("purged").asInt()).isEqualTo(remaining);
		assertThat(this.api.get("/api/trash").json().get("entries").isEmpty()).isTrue();
		try (var left = Files.list(vault.resolve(".trash"))) {
			assertThat(left).isEmpty();
		}
		assertThat(this.api.delete("/api/trash").ok(200).get("purged").asInt()).isZero();
	}

}
