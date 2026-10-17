package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

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

/** History disabled by configuration: notes keep working, history answers {@code 503 history-unavailable}. */
@NotesIntegrationTest
class GitDisabledIntegrationTest {

	private static final String COMMIT = "0123456789abcdef0123456789abcdef01234567";

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.git.enabled", "false"));
	}

	@Autowired
	RestTestClient client;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
	}

	@Test
	void historyIsUnavailableAndEverythingElseWorks() {
		assertThat(Files.exists(vault.resolve(".git"))).isFalse();
		assertThat(Files.exists(vault.resolve("Welcome.md"))).isTrue();
		JsonNode git = this.api.get("/api/status").ok(200).get("git");
		assertThat(git.get("enabled").asBoolean()).isFalse();
		assertThat(git.get("state").asString()).isEqualTo("disabled");
		assertThat(git.get("reason").asString()).isEqualTo("disabled by configuration");
		assertThat(git.get("head").isNull()).isTrue();
		assertThat(git.get("pendingPaths").asInt()).isZero();

		String version = this.api.postJson("/api/files", Map.of("path", "Plain.md", "content", "a"))
			.ok(201)
			.get("file")
			.get("version")
			.asString();
		JsonNode saved = this.api.putJson("/api/files?path=Plain.md",
				Map.of("content", "b", "baseVersion", version, "flushHistory", true)).ok(200);
		assertThat(saved.get("file").get("version").asString()).isNotEqualTo(version);
		JsonNode moved = this.api.postJson("/api/move", Map.of("from", "Plain.md", "to", "Moved.md")).ok(200);
		assertThat(moved.get("commitId").isNull()).isTrue();
		JsonNode trashed = this.api.delete("/api/files?path=Moved.md").ok(200);
		JsonNode restored = this.api.postEmpty("/api/trash/" + trashed.get("id").asString() + "/restore").ok(200);
		assertThat(restored.get("commitId").isNull()).isTrue();

		for (String uri : new String[] { "/api/history?path=Moved.md",
				"/api/history/content?path=Moved.md&commit=" + COMMIT, "/api/history/raw?path=Moved.md&commit=" + COMMIT }) {
			Api.Reply reply = this.api.get(uri);
			assertThat(reply.problem(503)).as(uri).isEqualTo("history-unavailable");
			assertThat(reply.json().get("reason").asString()).isEqualTo("disabled");
		}
		assertThat(this.api.postEmpty("/api/history/commit").problem(503)).isEqualTo("history-unavailable");
		assertThat(this.api.postJson("/api/history/restore",
				Map.of("path", "Moved.md", "commit", COMMIT, "baseVersion", "x")).problem(503))
			.isEqualTo("history-unavailable");
	}

}
