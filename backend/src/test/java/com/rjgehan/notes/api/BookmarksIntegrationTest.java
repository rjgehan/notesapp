package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
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

/** Bookmarks over HTTP and SSE (API.md §21): the version protocol, validation, events and re-keying on a move. */
@NotesIntegrationTest
class BookmarksIntegrationTest {

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

	private JsonNode bookmarks() {
		return this.api.get("/api/bookmarks").ok(200);
	}

	private static List<Map<String, Object>> file(String path) {
		return List.of(Map.of("type", "file", "ctime", 1760616202120L, "path", path));
	}

	@Test
	void bookmarksFollowTheVersionProtocolAndReachOtherDevices() throws Exception {
		JsonNode empty = bookmarks();
		assertThat(empty.get("items").isArray()).isTrue();
		assertThat(empty.get("items").size()).isZero();
		String base = empty.get("version").asString();
		assertThat(base).matches("[0-9a-f]{40}");

		this.api.postJson("/api/files", Map.of("path", "Starred.md", "content", "# Starred\n")).ok(201);
		String saved;
		try (SseRecorder others = SseRecorder.open(this.port, OBSERVER, null);
				SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			Reply reply = this.api.putJson("/api/bookmarks", Map.of("items", file("Starred.md"), "baseVersion", base));
			assertThat(reply.header("Cache-Control")).isEqualTo("no-store");
			JsonNode body = reply.ok(200);
			saved = body.get("version").asString();
			assertThat(saved).isNotEqualTo(base);
			assertThat(body.get("items").get(0).get("path").asString()).isEqualTo("Starred.md");
			others.awaitEvent("bookmarks.changed");
			JsonNode event = others.frames()
				.stream()
				.filter((frame) -> frame.event().equals("bookmarks.changed"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(event.get("version").asString()).isEqualTo(saved);
			assertThat(event.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			this.api.postJson("/api/files", Map.of("path", "After bookmarks.md")).ok(201);
			others.awaitEvent("file.created");
			assertThat(mine.eventNames()).doesNotContain("bookmarks.changed");
		}
		assertThat(Files.readString(vault.resolve(".notesapp/bookmarks.json"))).contains("\"path\": \"Starred.md\"");
		assertThat(bookmarks().get("version").asString()).isEqualTo(saved);

		Reply stale = this.api.putJson("/api/bookmarks", Map.of("items", List.of(), "baseVersion", base));
		assertThat(stale.problem(409)).isEqualTo("version-conflict");
		assertThat(stale.json().get("currentVersion").asString()).isEqualTo(saved);
		assertThat(stale.json().get("currentContent").asString()).contains("Starred.md");

		Reply invalid = this.api.putJson("/api/bookmarks",
				Map.of("items", List.of(Map.of("type", "file", "path", ".git/config")), "baseVersion", saved));
		assertThat(invalid.problem(400)).isEqualTo("bad-request");
		assertThat(invalid.json().get("errors").get(0).get("field").asString()).isEqualTo("items[0].path");
		assertThat(this.api.putJson("/api/bookmarks", Map.of("items", List.of())).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.putJson("/api/bookmarks", Map.of("items", List.of(), "baseVersion", saved), "X-Client-Id",
				null).problem(403)).isEqualTo("client-id-required");
	}

	@Test
	void aMoveReKeysBookmarksAndTellsEveryClientIncludingTheMover() {
		this.api.postJson("/api/files", Map.of("path", "Moving/Plan.md", "content", "# Plan\n")).ok(201);
		String base = bookmarks().get("version").asString();
		this.api.putJson("/api/bookmarks", Map.of("items",
				List.of(Map.of("type", "file", "ctime", 1, "path", "Moving/Plan.md", "subpath", "#Plan"),
						Map.of("type", "folder", "ctime", 2, "path", "Moving")),
				"baseVersion", base))
			.ok(200);
		try (SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			mine.awaitEvent("hello");
			this.api.postJson("/api/move", Map.of("from", "Moving", "to", "Moved")).ok(200);
			mine.awaitEvent("bookmarks.changed");
			JsonNode event = mine.frames()
				.stream()
				.filter((frame) -> frame.event().equals("bookmarks.changed"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(event.get("origin").isNull()).isTrue();
			JsonNode items = bookmarks().get("items");
			assertThat(event.get("version").asString()).isEqualTo(bookmarks().get("version").asString());
			assertThat(items.get(0).get("path").asString()).isEqualTo("Moved/Plan.md");
			assertThat(items.get(0).get("subpath").asString()).isEqualTo("#Plan");
			assertThat(items.get(1).get("path").asString()).isEqualTo("Moved");
		}
	}

}
