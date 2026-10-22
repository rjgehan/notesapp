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

/** Properties across the vault over HTTP and SSE (API.md §38). */
@NotesIntegrationTest
class PropertiesIntegrationTest {

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

	@Test
	void listTypeRenameAndSearch() {
		this.api.postJson("/api/files", Map.of("path", "P1.md", "content", "---\nstage: draft\n---\nOne\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "P2.md", "content", "---\nstage: final\n---\nTwo\n")).ok(201);

		JsonNode list = this.api.get("/api/properties").ok(200);
		JsonNode stage = list.get("properties").valueStream()
			.filter((p) -> p.get("name").asString().equals("stage"))
			.findFirst()
			.orElseThrow();
		assertThat(stage.get("count").asInt()).isEqualTo(2);
		assertThat(stage.get("type").isNull()).isTrue();
		assertThat(stage.get("inferred").asString()).isEqualTo("text");
		assertThat(this.api.get("/api/properties/values?name=stage").ok(200).get("values").size()).isEqualTo(2);
		JsonNode hits = this.api.get("/api/search?q=" + Api.enc("[stage:draft]")).ok(200).get("results");
		assertThat(hits.size()).isEqualTo(1);
		assertThat(hits.get(0).get("path").asString()).isEqualTo("P1.md");

		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null)) {
			others.awaitEvent("hello");
			JsonNode types = this.api.putJson("/api/properties/types", Map.of("name", "stage", "type", "text")).ok(200);
			assertThat(types.get("types").get("stage").asString()).isEqualTo("text");
			assertThat(types.get("source").asString()).isEqualTo("notesapp");
			others.awaitEvent("types.changed");

			JsonNode result = this.api
				.postJson("/api/properties/rename", Map.of("from", "stage", "to", "phase"))
				.ok(200);
			assertThat(result.get("updates").size()).isEqualTo(2);
			assertThat(result.get("typeMoved").asBoolean()).isTrue();
			assertThat(result.get("commitId").asString()).matches("[0-9a-f]{40}");
			others.awaitEvent("file.changed");
		}
		assertThat(this.api.get("/api/files?path=P1.md").ok(200).get("content").asString())
			.isEqualTo("---\nphase: draft\n---\nOne\n");
		assertThat(this.api.get("/api/properties/types").ok(200).get("types").get("phase").asString())
			.isEqualTo("text");

		Map<String, Object> clear = new HashMap<>();
		clear.put("name", "phase");
		clear.put("type", null);
		assertThat(this.api.putJson("/api/properties/types", clear).ok(200).get("types").has("phase")).isFalse();
		assertThat(this.api.putJson("/api/properties/types", Map.of("name", "x", "type", "colour")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/properties/rename", Map.of("from", "a", "to", "a")).problem(400))
			.isEqualTo("bad-request");
	}

}
