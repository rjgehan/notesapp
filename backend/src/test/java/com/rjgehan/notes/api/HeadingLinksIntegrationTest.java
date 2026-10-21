package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
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

/** Updating heading links after a heading is renamed, over HTTP and SSE (API.md §22). */
@NotesIntegrationTest
class HeadingLinksIntegrationTest {

	private static final String OBSERVER = "observer-client-01";

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
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

	private String read(String path) {
		return this.api.get("/api/files?path=" + Api.enc(path)).ok(200).get("content").asString();
	}

	@Test
	void renamingAHeadingUpdatesItsLinksAfterAPreview() {
		JsonNode plan = this.api.postJson("/api/files", Map.of("path", "Plan.md", "content", "# Plan\n## Goals\n"))
			.ok(201);
		this.api.postJson("/api/files", Map.of("path", "Notes.md", "content", "See [[Plan#Goals|goals]].\n")).ok(201);
		this.api.putJson("/api/files?path=Plan.md",
				Map.of("content", "# Plan\n## Aims\n", "baseVersion", plan.get("file").get("version").asString()))
			.ok(200);
		Map<String, Object> request = Map.of("path", "Plan.md", "from", "Goals", "to", "Aims", "dryRun", true);
		JsonNode preview = this.api.postJson("/api/notes/rename-heading", request).ok(200);
		assertThat(preview.get("dryRun").asBoolean()).isTrue();
		assertThat(preview.get("linkUpdates").get(0).get("path").asString()).isEqualTo("Notes.md");
		assertThat(preview.get("linkUpdates").get(0).get("version").isNull()).isTrue();
		assertThat(preview.get("commitId").isNull()).isTrue();
		assertThat(read("Notes.md")).isEqualTo("See [[Plan#Goals|goals]].\n");

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			others.awaitEvent("hello");
			JsonNode result = this.api
				.postJson("/api/notes/rename-heading", Map.of("path", "Plan.md", "from", "Goals", "to", "Aims"))
				.ok(200);
			assertThat(result.get("linkUpdates").get(0).get("links").asInt()).isEqualTo(1);
			assertThat(result.get("commitId").asString()).matches("[0-9a-f]{40}");
			assertThat(result.get("bookmarks").asInt()).isZero();
			others.awaitEvent("file.changed");
		}
		assertThat(read("Notes.md")).isEqualTo("See [[Plan#Aims|goals]].\n");

		assertThat(this.api.postJson("/api/notes/rename-heading", Map.of("path", "Plan.md", "from", "Goals", "to", "Nope"))
			.problem(400)).isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/notes/rename-heading", Map.of("path", ".git/x.md", "from", "a", "to", "b"))
			.problem(403)).isEqualTo("reserved-path");
	}

}
