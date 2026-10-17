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
import com.rjgehan.notes.vault.Hashing;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Settings, identity and server status (API.md §5 and §6). */
@NotesIntegrationTest
class SettingsIntegrationTest {

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
	void meDescribesTheDefaultIdentity() {
		JsonNode me = this.api.get("/api/me").ok(200);
		assertThat(me.get("login").asString()).isEqualTo("owner@notes");
		assertThat(me.get("name").asString()).isEqualTo("Owner");
		assertThat(me.has("profilePicUrl")).isTrue();
		assertThat(me.get("profilePicUrl").isNull()).isTrue();
		assertThat(me.get("source").asString()).isEqualTo("default");
		assertThat(me.size()).isEqualTo(4);
	}

	@Test
	void statusDescribesTheServer() {
		Reply response = this.api.get("/api/status");
		JsonNode status = response.ok(200);
		assertThat(response.header("Cache-Control")).isEqualTo("no-store");
		assertThat(status.get("appVersion").asString()).isEqualTo("0.0.1-SNAPSHOT");
		assertThat(status.get("buildSha").asString()).isEqualTo("dev");
		assertThat(status.get("bootId").asString()).matches("[0-9a-z]+");
		assertThat(status.get("eventId").asString()).startsWith(status.get("bootId").asString() + ".");
		assertThat(status.get("startedAt").asString()).matches(".*T.*\\.\\d{3}Z");
		JsonNode vaultStats = status.get("vault");
		assertThat(vaultStats.get("notes").asInt()).isPositive();
		assertThat(vaultStats.get("files").asInt()).isGreaterThanOrEqualTo(vaultStats.get("notes").asInt());
		assertThat(vaultStats.get("folders").asInt()).isNotNegative();
		assertThat(vaultStats.get("bytes").asLong()).isPositive();
		assertThat(vaultStats.get("skipped").isArray()).isTrue();
		assertThat(vaultStats.get("unwritableDirs").isArray()).isTrue();
		assertThat(status.get("index").get("builtInMs").asLong()).isNotNegative();
		assertThat(status.get("index").has("lastRescanAt")).isTrue();
		JsonNode git = status.get("git");
		assertThat(git.get("enabled").asBoolean()).isTrue();
		assertThat(git.get("state").asString()).isEqualTo("ready");
		assertThat(git.get("reason").isNull()).isTrue();
		assertThat(git.get("head").asString()).matches("[0-9a-f]{40}");
		assertThat(git.get("pendingPaths").asInt()).isNotNegative();
		for (String field : List.of("nextCommitAt", "lastCommitAt", "lastError", "failingSince")) {
			assertThat(git.has(field)).as(field).isTrue();
		}
		assertThat(git.get("lastError").isNull()).isTrue();
		assertThat(git.get("failingSince").isNull()).isTrue();
		assertThat(status.get("watcher").get("mode").asString()).isEqualTo("disabled");
		assertThat(status.get("disk").get("freeBytes").asLong()).isPositive();
		assertThat(status.get("disk").has("repoBytes")).isTrue();
		assertThat(status.get("settings").get("readOnly").asBoolean()).isFalse();
		assertThat(status.get("settings").get("reason").isNull()).isTrue();

		this.api.postJson("/api/files", Map.of("path", "Pending.md")).ok(201);
		JsonNode pending = this.api.get("/api/status").ok(200).get("git");
		assertThat(pending.get("pendingPaths").asInt()).isPositive();
		assertThat(pending.get("nextCommitAt").asString()).endsWith("Z");
	}

	@Test
	void settingsFollowTheVersionProtocol() throws Exception {
		JsonNode current = this.api.get("/api/settings").ok(200);
		assertThat(current.get("readOnly").asBoolean()).isFalse();
		JsonNode defaults = current.get("settings");
		assertThat(defaults.get("schemaVersion").asInt()).isEqualTo(1);
		assertThat(defaults.get("files").get("newNoteLocation").asString()).isEqualTo("root");
		assertThat(defaults.get("files").get("newLinkFormat").asString()).isEqualTo("shortest");
		assertThat(defaults.get("files").get("attachmentLocation").asString()).isEqualTo("folder");
		assertThat(defaults.get("files").get("attachmentFolder").asString()).isEqualTo("Attachments");
		assertThat(defaults.get("files").get("attachmentSubfolder").asString()).isEqualTo("attachments");
		assertThat(defaults.get("dailyNotes").get("format").asString()).isEqualTo("YYYY-MM-DD");
		assertThat(defaults.get("dailyNotes").get("folder").asString()).isEqualTo("Daily");
		assertThat(defaults.get("templates").get("timeFormat").asString()).isEqualTo("HH:mm");
		assertThat(defaults.get("editor").get("defaultMode").asString()).isEqualTo("edit");
		assertThat(defaults.get("editor").get("strictLineBreaks").asBoolean()).isFalse();
		String base = current.get("version").asString();

		ObjectNode changed = (ObjectNode) defaults.deepCopy();
		((ObjectNode) changed.get("editor")).put("readableLineLength", false);
		String next;
		try (SseRecorder others = SseRecorder.open(this.port, "observer-client-01", null);
				SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			JsonNode saved = this.api.putJson("/api/settings", Map.of("settings", changed, "baseVersion", base)).ok(200);
			next = saved.get("version").asString();
			assertThat(next).isNotEqualTo(base);
			assertThat(saved.get("settings").get("editor").get("readableLineLength").asBoolean()).isFalse();
			others.awaitEvent("settings.changed");
			JsonNode event = others.frames()
				.stream()
				.filter((frame) -> frame.event().equals("settings.changed"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(event.get("version").asString()).isEqualTo(next);
			assertThat(event.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			this.api.postJson("/api/files", Map.of("path", "After settings.md")).ok(201);
			others.awaitEvent("file.created");
			assertThat(mine.eventNames()).doesNotContain("settings.changed");
		}
		assertThat(this.api.putJson("/api/settings", Map.of("settings", changed, "baseVersion", base)).ok(200)
			.get("version").asString()).isEqualTo(next);

		Reply stale = this.api.putJson("/api/settings", Map.of("settings", defaults, "baseVersion", base));
		assertThat(stale.problem(409)).isEqualTo("version-conflict");
		assertThat(stale.json().get("currentVersion").asString()).isEqualTo(next);
		assertThat(stale.json().get("currentContent").asString()).contains("\"readableLineLength\": false");
		assertThat(stale.json().has("currentMtime")).isTrue();
		assertThat(stale.json().has("movedTo")).isTrue();

		ObjectNode invalid = (ObjectNode) defaults.deepCopy();
		((ObjectNode) invalid.get("files")).put("newLinkFormat", "longest");
		((ObjectNode) invalid.get("files")).put("attachmentSubfolder", "a/b");
		((ObjectNode) invalid.get("dailyNotes")).put("format", "");
		((ObjectNode) invalid.get("templates")).remove("folder");
		Reply rejected = this.api.putJson("/api/settings", Map.of("settings", invalid, "baseVersion", next));
		assertThat(rejected.problem(400)).isEqualTo("bad-request");
		assertThat(rejected.json().get("errors").values().stream().map((e) -> e.get("field").asString()))
			.contains("settings.files.newLinkFormat", "settings.files.attachmentSubfolder", "settings.dailyNotes.format",
					"settings.templates.folder");
		assertThat(this.api.putJson("/api/settings", Map.of("settings", defaults)).problem(400)).isEqualTo("bad-request");

		Path file = vault.resolve(".notesapp/settings.json");
		String text = Files.readString(file);
		Files.writeString(file, text.replace("\"schemaVersion\": 1", "\"futureField\": [1, 2],\n  \"schemaVersion\": 1"));
		JsonNode external = this.api.get("/api/settings").ok(200);
		ObjectNode again = (ObjectNode) external.get("settings").deepCopy();
		((ObjectNode) again.get("editor")).put("readableLineLength", true);
		String diskVersion = Hashing.blobId(Files.readAllBytes(file));
		this.api.putJson("/api/settings", Map.of("settings", again, "baseVersion", diskVersion)).ok(200);
		assertThat(Files.readString(file)).contains("\"futureField\"").contains("\"readableLineLength\": true");
	}

}
