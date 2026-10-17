package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
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
 * History list, content, raw and restore (DESIGN §8.1 integration item 8). Batches never commit on their own here;
 * the tests commit with {@code POST /api/history/commit}.
 */
@NotesIntegrationTest
class HistoryIntegrationTest {

	private static final String UNKNOWN_COMMIT = "0123456789abcdef0123456789abcdef01234567";

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

	private String create(String path, String content) {
		return this.api.postJson("/api/files", Map.of("path", path, "content", content))
			.ok(201)
			.get("file")
			.get("version")
			.asString();
	}

	private String save(String path, String content, String base) {
		return this.api.putJson("/api/files?path=" + Api.enc(path), Map.of("content", content, "baseVersion", base))
			.ok(200)
			.get("file")
			.get("version")
			.asString();
	}

	private String commit() {
		return this.api.postEmpty("/api/history/commit").ok(200).get("commitId").asString();
	}

	private JsonNode history(String path) {
		return this.api.get("/api/history?path=" + Api.enc(path)).ok(200);
	}

	private List<JsonNode> entries(String path) {
		List<JsonNode> entries = new ArrayList<>();
		history(path).get("entries").forEach(entries::add);
		return entries;
	}

	@Test
	void listContentAndRestore() {
		String v1 = create("Hist/Story.md", "one\n");
		JsonNode pending = history("Hist/Story.md");
		assertThat(pending.get("pending").asBoolean()).isTrue();
		assertThat(pending.get("entries").isEmpty()).isTrue();
		String first = commit();
		String v2 = save("Hist/Story.md", "two\n", v1);
		String second = commit();
		assertThat(this.api.postEmpty("/api/history/commit").ok(200).get("commitId").isNull()).isTrue();

		JsonNode log = history("Hist/Story.md");
		assertThat(log.get("path").asString()).isEqualTo("Hist/Story.md");
		assertThat(log.get("pending").asBoolean()).isFalse();
		assertThat(log.get("hasMore").asBoolean()).isFalse();
		JsonNode newest = log.get("entries").get(0);
		assertThat(newest.get("commitId").asString()).isEqualTo(second);
		assertThat(newest.get("shortId").asString()).isEqualTo(second.substring(0, 7));
		assertThat(newest.get("parentCommitId").asString()).isEqualTo(first);
		assertThat(newest.get("path").asString()).isEqualTo("Hist/Story.md");
		assertThat(newest.get("time").asString()).matches(".*T.*\\.000Z");
		assertThat(newest.get("authorName").asString()).isEqualTo("Owner");
		assertThat(newest.get("authorLogin").asString()).isEqualTo("owner@notes");
		assertThat(newest.get("message").asString()).isEqualTo("Update Hist/Story.md");
		assertThat(newest.get("change").asString()).isEqualTo("modified");
		assertThat(newest.get("renamedFrom").isNull()).isTrue();
		assertThat(log.get("entries").get(1).get("change").asString()).isEqualTo("added");
		assertThat(log.get("entries").get(1).get("commitId").asString()).isEqualTo(first);

		JsonNode page = this.api.get("/api/history?path=" + Api.enc("Hist/Story.md") + "&limit=1").ok(200);
		assertThat(page.get("entries").size()).isEqualTo(1);
		assertThat(page.get("hasMore").asBoolean()).isTrue();
		JsonNode next = this.api.get("/api/history?path=" + Api.enc("Hist/Story.md") + "&limit=1&offset=1").ok(200);
		assertThat(next.get("entries").get(0).get("commitId").asString()).isEqualTo(first);
		assertThat(next.get("hasMore").asBoolean()).isFalse();

		JsonNode content = this.api
			.get("/api/history/content?path=" + Api.enc("Hist/Story.md") + "&commit=" + first)
			.ok(200);
		assertThat(content.get("commitId").asString()).isEqualTo(first);
		assertThat(content.get("path").asString()).isEqualTo("Hist/Story.md");
		assertThat(content.get("content").asString()).isEqualTo("one\n");
		assertThat(content.get("version").asString()).isEqualTo(v1);
		assertThat(content.get("size").asLong()).isEqualTo(4);
		assertThat(content.get("binary").asBoolean()).isFalse();
		assertThat(content.get("lossy").asBoolean()).isFalse();

		Reply raw = this.api.get("/api/history/raw?path=" + Api.enc("Hist/Story.md") + "&commit=" + first);
		assertThat(raw.status()).isEqualTo(200);
		assertThat(raw.text()).isEqualTo("one\n");
		assertThat(raw.header("Cache-Control")).isEqualTo("private, max-age=31536000, immutable");
		assertThat(raw.header("Content-Security-Policy")).startsWith("sandbox;");
		assertThat(raw.header("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(raw.header("Content-Type")).startsWith("text/plain");

		try (SseRecorder others = SseRecorder.open(this.port, "observer-client-01", null)) {
			JsonNode restored = this.api
				.postJson("/api/history/restore", Map.of("path", "Hist/Story.md", "commit", first, "baseVersion", v2))
				.ok(200);
			assertThat(restored.get("file").get("version").asString()).isEqualTo(v1);
			assertThat(restored.get("created").asBoolean()).isFalse();
			assertThat(restored.get("createdFolders").isEmpty()).isTrue();
			String restoreCommit = restored.get("commitId").asString();
			assertThat(others.awaitEvent("history.committed")).containsExactly("file.changed", "history.committed");
			assertThat(entries("Hist/Story.md").get(0).get("commitId").asString()).isEqualTo(restoreCommit);
		}
		assertThat(entries("Hist/Story.md").get(0).get("message").asString())
			.isEqualTo("Restore Hist/Story.md to version " + first.substring(0, 7));
		assertThat(this.api.get("/api/files?path=" + Api.enc("Hist/Story.md")).json().get("content").asString())
			.isEqualTo("one\n");
	}

	@Test
	void anEditJustBeforeARestoreStaysInHistory() {
		String v1 = create("Keep/Note.md", "original\n");
		String first = commit();
		String edited = save("Keep/Note.md", "edited just now\n", v1);
		JsonNode restored = this.api
			.postJson("/api/history/restore", Map.of("path", "Keep/Note.md", "commit", first, "baseVersion", edited))
			.ok(200);
		assertThat(restored.get("file").get("version").asString()).isEqualTo(v1);
		List<JsonNode> log = entries("Keep/Note.md");
		assertThat(log.stream().map((e) -> e.get("message").asString())).containsExactly(
				"Restore Keep/Note.md to version " + first.substring(0, 7), "Update Keep/Note.md", "Create Keep/Note.md");
		JsonNode kept = this.api
			.get("/api/history/content?path=" + Api.enc("Keep/Note.md") + "&commit=" + log.get(1).get("commitId").asString())
			.ok(200);
		assertThat(kept.get("content").asString()).isEqualTo("edited just now\n");
	}

	@Test
	void historyFollowsRenamesAndDeletedFilesKeepTheirHistory() {
		create("Old/Name.md", "text\n");
		commit();
		this.api.postJson("/api/move", Map.of("from", "Old/Name.md", "to", "New/Name 2.md")).ok(200);
		List<JsonNode> log = entries("New/Name 2.md");
		assertThat(log).hasSize(2);
		assertThat(log.get(0).get("change").asString()).isEqualTo("renamed");
		assertThat(log.get(0).get("path").asString()).isEqualTo("New/Name 2.md");
		assertThat(log.get(0).get("renamedFrom").asString()).isEqualTo("Old/Name.md");
		assertThat(log.get(1).get("path").asString()).isEqualTo("Old/Name.md");
		assertThat(log.get(1).get("change").asString()).isEqualTo("added");
		JsonNode atOldPath = this.api.get("/api/history/content?path=" + Api.enc("Old/Name.md") + "&commit="
				+ log.get(1).get("commitId").asString()).ok(200);
		assertThat(atOldPath.get("content").asString()).isEqualTo("text\n");

		this.api.delete("/api/files?path=" + Api.enc("New/Name 2.md")).ok(200);
		JsonNode deleted = entries("New/Name 2.md").get(0);
		assertThat(deleted.get("change").asString()).isEqualTo("deleted");
		assertThat(this.api.get("/api/history/content?path=" + Api.enc("New/Name 2.md") + "&commit="
				+ deleted.get("commitId").asString()).problem(404)).isEqualTo("not-found");
		JsonNode last = this.api.get("/api/history/content?path=" + Api.enc("New/Name 2.md") + "&commit="
				+ deleted.get("parentCommitId").asString()).ok(200);
		assertThat(last.get("content").asString()).isEqualTo("text\n");

		Map<String, Object> recreate = new HashMap<>();
		recreate.put("path", "New/Name 2.md");
		recreate.put("commit", deleted.get("parentCommitId").asString());
		recreate.put("baseVersion", null);
		this.api.delete("/api/folders?path=New").ok(200);
		JsonNode restored = this.api.postJson("/api/history/restore", recreate).ok(200);
		assertThat(restored.get("created").asBoolean()).isTrue();
		assertThat(restored.get("createdFolders").values().stream().map(JsonNode::asString)).containsExactly("New");
		assertThat(this.api.postJson("/api/history/restore", recreate).problem(409)).isEqualTo("already-exists");
	}

	@Test
	void binaryVersionsAndRestoreRules() {
		byte[] v1 = { 1, 2, 3 };
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Bin/pic.png"), v1).ok(201);
		String first = commit();
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Bin/pic.png") + "&onConflict=overwrite", new byte[] { 9 })
			.ok(200);
		commit();
		JsonNode content = this.api.get("/api/history/content?path=" + Api.enc("Bin/pic.png") + "&commit=" + first)
			.ok(200);
		assertThat(content.get("binary").asBoolean()).isTrue();
		assertThat(content.has("content")).isTrue();
		assertThat(content.get("content").isNull()).isTrue();
		assertThat(content.get("size").asLong()).isEqualTo(3);
		Reply raw = this.api.get("/api/history/raw?path=" + Api.enc("Bin/pic.png") + "&commit=" + first);
		assertThat(raw.body()).isEqualTo(v1);
		assertThat(raw.header("Content-Type")).isEqualTo("image/png");

		Map<String, Object> withBase = new HashMap<>();
		withBase.put("path", "Bin/pic.png");
		withBase.put("commit", first);
		withBase.put("baseVersion", "x");
		assertThat(this.api.postJson("/api/history/restore", withBase).problem(400)).isEqualTo("bad-request");
		withBase.put("baseVersion", null);
		JsonNode restored = this.api.postJson("/api/history/restore", withBase).ok(200);
		assertThat(restored.get("file").get("size").asLong()).isEqualTo(3);
		assertThat(this.api.get("/api/files/raw?path=" + Api.enc("Bin/pic.png")).body()).isEqualTo(v1);
	}

	@Test
	void textRestoreChecksTheBaseVersion() {
		String v1 = create("Base/Note.md", "a\n");
		String first = commit();
		String v2 = save("Base/Note.md", "b\n", v1);
		Reply stale = this.api.postJson("/api/history/restore",
				Map.of("path", "Base/Note.md", "commit", first, "baseVersion", v1));
		assertThat(stale.problem(409)).isEqualTo("version-conflict");
		assertThat(stale.json().get("currentVersion").asString()).isEqualTo(v2);
		assertThat(stale.json().get("currentContent").asString()).isEqualTo("b\n");
		Map<String, Object> nullBase = new HashMap<>();
		nullBase.put("path", "Base/Note.md");
		nullBase.put("commit", first);
		nullBase.put("baseVersion", null);
		assertThat(this.api.postJson("/api/history/restore", nullBase).problem(409)).isEqualTo("already-exists");
		Map<String, Object> source = new HashMap<>(nullBase);
		source.put("sourcePath", "Base/Missing.md");
		source.put("baseVersion", v2);
		assertThat(this.api.postJson("/api/history/restore", source).problem(404)).isEqualTo("not-found");
	}

	@Test
	void requestsAreValidated() {
		create("Valid/Note.md", "x");
		String commit = commit();
		assertThat(this.api.get("/api/history/content?path=x.md&commit=abc").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history/content?path=x.md&commit=" + commit.substring(0, 7)).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.get("/api/history/content?path=x.md&commit=" + UNKNOWN_COMMIT).problem(404))
			.isEqualTo("not-found");
		assertThat(this.api.get("/api/history/content?path=Absent.md&commit=" + commit).problem(404))
			.isEqualTo("not-found");
		assertThat(this.api.get("/api/history/raw?path=x.md&commit=nope").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history?path=x.md&limit=0").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history?path=x.md&limit=201").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history?path=x.md&offset=-1").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history?path=Never/Existed.md").ok(200).get("entries").isEmpty()).isTrue();
		assertThat(this.api.postJson("/api/history/restore",
				Map.of("path", "Valid/Note.md", "commit", "zz", "baseVersion", "x")).problem(400))
			.isEqualTo("bad-request");
		Reply textTooLarge = this.api.get("/api/history/content?path=" + Api.enc("Valid/Note.md") + "&commit=" + commit);
		assertThat(textTooLarge.ok(200).get("content").asString()).isEqualTo("x");
		assertThat(new String(this.api.get("/api/history/raw?path=" + Api.enc("Valid/Note.md") + "&commit=" + commit)
			.body(), StandardCharsets.UTF_8)).isEqualTo("x");
	}

}
