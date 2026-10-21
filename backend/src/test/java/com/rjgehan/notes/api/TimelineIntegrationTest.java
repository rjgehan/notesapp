package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The vault-wide timeline, changes over a period, and restoring a file from git after the trash was emptied (API.md
 * §14.6–14.8, ROADMAP item 28).
 */
@NotesIntegrationTest
class TimelineIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.git.commit-quiet-period", "1h", "notes.git.commit-max-delay", "1h"));
	}

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

	@Test
	void timelineChangesAndRestoringADeletedFileFromGit() throws Exception {
		Instant before = Instant.now().minusSeconds(5);
		this.api.postJson("/api/files", Map.of("path", "Old/Gone.md", "content", "last words\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Stays.md", "content", "here\n")).ok(201);
		this.api.postEmpty("/api/history/commit").ok(200);
		this.api.delete("/api/files?path=" + Api.enc("Old/Gone.md")).ok(200);
		this.api.delete("/api/trash").ok(200);

		JsonNode log = this.api.get("/api/history/log?limit=10").ok(200);
		JsonNode deletion = log.get("entries").get(0);
		assertThat(deletion.get("message").asString()).isEqualTo("Delete Old/Gone.md");
		assertThat(deletion.get("files").get(0).get("path").asString()).isEqualTo("Old/Gone.md");
		assertThat(deletion.get("files").get(0).get("change").asString()).isEqualTo("deleted");
		assertThat(deletion.get("filesTotal").asInt()).isEqualTo(1);
		assertThat(deletion.get("time").asString()).endsWith("Z");
		assertThat(this.api.get("/api/history/log?path=Stays.md").ok(200).get("entries").size()).isEqualTo(1);
		assertThat(this.api.get("/api/history/log?author=nobody-at-all").ok(200).get("entries").isEmpty()).isTrue();
		assertThat(this.api.get("/api/history/log?since=bad").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/history/log?limit=0").problem(400)).isEqualTo("bad-request");

		JsonNode changes = this.api.get("/api/history/changes?since=" + Api.enc(before.toString())).ok(200);
		assertThat(changes.get("commits").asInt()).isGreaterThanOrEqualTo(2);
		assertThat(changes.get("files").valueStream().map((f) -> f.get("path").asString())).contains("Stays.md")
			.doesNotContain("Old/Gone.md");
		assertThat(this.api.get("/api/history/changes?since=2026-10-02T00:00:00Z&until=2026-10-01T00:00:00Z")
			.problem(400)).isEqualTo("bad-request");

		JsonNode deleted = this.api.get("/api/history/deleted?q=gone").ok(200);
		assertThat(deleted.get("total").asInt()).isEqualTo(1);
		JsonNode gone = deleted.get("entries").get(0);
		assertThat(gone.get("path").asString()).isEqualTo("Old/Gone.md");
		Map<String, Object> restore = new HashMap<>();
		restore.put("path", "Old/Gone.md");
		restore.put("commit", gone.get("parentCommitId").asString());
		restore.put("sourcePath", "Old/Gone.md");
		restore.put("baseVersion", null);
		JsonNode restored = this.api.postJson("/api/history/restore", restore).ok(200);
		assertThat(restored.get("created").asBoolean()).isTrue();
		assertThat(Files.readString(vault.resolve("Old/Gone.md"))).isEqualTo("last words\n");
		assertThat(this.api.get("/api/history/deleted?q=gone").ok(200).get("total").asInt()).isZero();
	}

}
