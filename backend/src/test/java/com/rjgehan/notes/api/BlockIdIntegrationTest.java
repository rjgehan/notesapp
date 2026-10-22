package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
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

/** Adding a block id to a note (API.md §37, ROADMAP item 20), over HTTP and SSE. */
@NotesIntegrationTest
class BlockIdIntegrationTest {

	private static final String OBSERVER = "observer-client-02";

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

	private static Map<String, Object> request(String path, int line, String lineText, String placement, String id) {
		Map<String, Object> body = new HashMap<>();
		body.put("path", path);
		body.put("line", line);
		body.put("lineText", lineText);
		body.put("placement", placement);
		if (id != null) {
			body.put("id", id);
		}
		return body;
	}

	@Test
	void addsAnIdToTheCurrentTextEvenAfterLinesMoved() {
		this.api.postJson("/api/files", Map.of("path", "Plan.md", "content", "# Plan\n\nFirst idea\n\n| a |\n|---|\n"))
			.ok(201);
		// Another device inserted a line since the client read the note.
		JsonNode current = this.api.get("/api/files?path=Plan.md").ok(200);
		this.api.putJson("/api/files?path=Plan.md", Map.of("content", "Intro\n# Plan\n\nFirst idea\n\n| a |\n|---|\n",
				"baseVersion", current.get("version").asString())).ok(200);

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			others.awaitEvent("hello");
			JsonNode result = this.api.postJson("/api/notes/block-id", request("Plan.md", 2, "First idea", "end", "idea1"))
				.ok(200);
			assertThat(result.get("id").asString()).isEqualTo("idea1");
			assertThat(result.get("created").asBoolean()).isTrue();
			assertThat(result.get("line").asInt()).isEqualTo(3);
			assertThat(result.get("file").get("path").asString()).isEqualTo("Plan.md");
			others.awaitEvent("file.changed");
		}
		JsonNode table = this.api.postJson("/api/notes/block-id", request("Plan.md", 6, "|---|", "after", null)).ok(200);
		String tableId = table.get("id").asString();
		assertThat(tableId).matches("[a-z0-9]{6}");
		assertThat(read("Plan.md")).isEqualTo("Intro\n# Plan\n\nFirst idea ^idea1\n\n| a |\n|---|\n\n^" + tableId + "\n");

		// Asking again gives the id the block already has, without writing.
		JsonNode again = this.api.postJson("/api/notes/block-id", request("Plan.md", 3, "First idea ^idea1", "end", "x"))
			.ok(200);
		assertThat(again.get("id").asString()).isEqualTo("idea1");
		assertThat(again.get("created").asBoolean()).isFalse();
		// A taken id is not reused for another block.
		JsonNode other = this.api.postJson("/api/notes/block-id", request("Plan.md", 1, "# Plan", "end", "IDEA1")).ok(200);
		assertThat(other.get("id").asString()).isNotEqualToIgnoringCase("idea1");
	}

	@Test
	void refusesBlocksThatAreGoneAndFilesThatAreNotNotes() {
		this.api.postJson("/api/files", Map.of("path", "Gone.md", "content", "same\nsame\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "data.txt", "content", "text\n")).ok(201);
		assertThat(this.api.postJson("/api/notes/block-id", request("Gone.md", 0, "other", "end", null)).problem(409))
			.isEqualTo("block-not-found");
		assertThat(this.api.postJson("/api/notes/block-id", request("Gone.md", 5, "same", "end", null)).problem(409))
			.isEqualTo("block-not-found");
		assertThat(this.api.postJson("/api/notes/block-id", request("data.txt", 0, "text", "end", null)).problem(409))
			.isEqualTo("type-mismatch");
		assertThat(this.api.postJson("/api/notes/block-id", request("Gone.md", 0, "same", "middle", null)).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/notes/block-id", request("Gone.md", 0, "same", "end", "bad id")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/notes/block-id", request("Nope.md", 0, "x", "end", null)).problem(404))
			.isEqualTo("not-found");
		assertThat(read("Gone.md")).isEqualTo("same\nsame\n");
	}

}
