package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.watch.VaultReconciler;
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

/**
 * Quick capture (API.md §8.5, §8.6): the inbox and today's daily note, "today" decided by the device, templates for a
 * new daily note, appends that keep the file's bytes and line endings, idempotent retries, the CSRF rule for an iOS
 * Shortcut, attachments, and the share-target fallback route.
 */
@NotesIntegrationTest
class CaptureIntegrationTest {

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

	@Autowired
	VaultReconciler reconciler;

	private Api api;

	@BeforeEach
	void setUp() throws IOException {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private static Map<String, Object> capture(Object... pairs) {
		Map<String, Object> body = new LinkedHashMap<>();
		for (int i = 0; i < pairs.length; i += 2) {
			body.put((String) pairs[i], pairs[i + 1]);
		}
		return body;
	}

	private String disk(String path) throws IOException {
		return Files.readString(vault.resolve(path), StandardCharsets.UTF_8);
	}

	private void updateSettings(String group, Consumer<ObjectNode> change) {
		JsonNode current = this.api.get("/api/settings").ok(200);
		ObjectNode settings = (ObjectNode) current.get("settings").deepCopy();
		change.accept((ObjectNode) settings.get(group));
		this.api.putJson("/api/settings", Map.of("settings", settings, "baseVersion", current.get("version").asString()))
			.ok(200);
	}

	@Test
	void theFirstCaptureCreatesTheInboxAndLaterOnesAppend() throws IOException {
		Files.deleteIfExists(vault.resolve("Inbox.md"));
		JsonNode first = this.api
			.postJson("/api/capture", capture("text", "Call the plumber", "date", "2026-10-16", "time", "14:03"))
			.ok(201);
		assertThat(first.get("file").get("path").asString()).isEqualTo("Inbox.md");
		assertThat(first.get("created").asBoolean()).isTrue();
		assertThat(first.get("target").asString()).isEqualTo("inbox");
		assertThat(first.get("attachment").isNull()).isTrue();
		JsonNode second = this.api
			.postJson("/api/capture",
					capture("text", "Shopping\n- milk", "target", "inbox", "date", "2026-10-17", "time", "08:15"))
			.ok(200);
		assertThat(second.get("created").asBoolean()).isFalse();
		assertThat(disk("Inbox.md"))
			.isEqualTo("- 2026-10-16 14:03 Call the plumber\n- 2026-10-17 08:15 Shopping\n  - milk\n");
		JsonNode read = this.api.get("/api/files?path=Inbox.md").ok(200);
		assertThat(read.get("version").asString()).isEqualTo(second.get("file").get("version").asString());
	}

	@Test
	void todayIsTheDevicesDayEvenWhenTheServerIsElsewhere() throws IOException {
		updateSettings("dailyNotes", (d) -> d.put("folder", "Journal").put("format", "YYYY/MM-MMMM/YYYY-MM-DD dddd"));
		try {
			JsonNode result = this.api
				.postJson("/api/capture",
						capture("text", "Late thought", "target", "daily", "date", "2026-10-16", "time", "23:58"))
				.ok(201);
			String path = "Journal/2026/10-October/2026-10-16 Friday.md";
			assertThat(result.get("file").get("path").asString()).isEqualTo(path);
			assertThat(result.get("createdFolders").values().stream().map(JsonNode::asString).toList())
				.containsExactly("Journal", "Journal/2026", "Journal/2026/10-October");
			assertThat(disk(path)).isEqualTo("- 23:58 Late thought\n");
			// Only a time zone: the date and time are the device's, whatever the server's zone.
			JsonNode tz = this.api
				.postJson("/api/capture", capture("text", "From Tokyo", "target", "daily", "tz", "Pacific/Kiritimati"))
				.ok(201);
			assertThat(tz.get("file").get("path").asString()).startsWith("Journal/");
		}
		finally {
			updateSettings("dailyNotes", (d) -> d.put("folder", "Daily").put("format", "YYYY-MM-DD"));
		}
	}

	@Test
	void aNewDailyNoteStartsFromItsTemplateAndAnExistingOneIsFoundIgnoringCase() throws IOException {
		this.api
			.postJson("/api/files",
					Map.of("path", "Templates/Day.md", "content", "# {{title}}\n\nWritten {{date:dddd}} at {{time}}"))
			.ok(201);
		updateSettings("dailyNotes", (d) -> d.put("template", "Templates/Day.md"));
		try {
			JsonNode created = this.api
				.postJson("/api/capture",
						capture("text", "Idea", "target", "daily", "date", "2026-11-02", "time", "09:30"))
				.ok(201);
			assertThat(created.get("file").get("path").asString()).isEqualTo("Daily/2026-11-02.md");
			assertThat(disk("Daily/2026-11-02.md"))
				.isEqualTo("# 2026-11-02\n\nWritten Monday at 09:30\n- 09:30 Idea\n");
		}
		finally {
			updateSettings("dailyNotes", (d) -> d.put("template", ""));
		}
		// Created over SSH with another case: the capture appends to it rather than failing on the case.
		Files.writeString(vault.resolve("Daily/2026-11-03.MD"), "existing");
		this.reconciler.fullRescan(false);
		JsonNode appended = this.api
			.postJson("/api/capture", capture("text", "More", "target", "daily", "date", "2026-11-03", "time", "10:00"))
			.ok(200);
		assertThat(appended.get("file").get("path").asString()).isEqualTo("Daily/2026-11-03.MD");
		assertThat(disk("Daily/2026-11-03.MD")).isEqualTo("existing\n- 10:00 More\n");
	}

	@Test
	void appendsKeepTheFilesBytesAndLineEndings() throws IOException {
		byte[] bom = { (byte) 0xEF, (byte) 0xBB, (byte) 0xBF };
		byte[] text = "# Inbox\r\n\r\n- old".getBytes(StandardCharsets.UTF_8);
		byte[] crlf = new byte[bom.length + text.length];
		System.arraycopy(bom, 0, crlf, 0, 3);
		System.arraycopy(text, 0, crlf, 3, text.length);
		Files.write(vault.resolve("Inbox.md"), crlf);
		this.reconciler.fullRescan(false);
		this.api.postJson("/api/capture", capture("text", "two\nlines", "date", "2026-10-16", "time", "14:03")).ok(200);
		byte[] after = Files.readAllBytes(vault.resolve("Inbox.md"));
		assertThat(new String(after, StandardCharsets.UTF_8))
			.isEqualTo("﻿# Inbox\r\n\r\n- old\r\n- 2026-10-16 14:03 two\r\n  lines\r\n");
	}

	@Test
	void otherClientsSeeTheChangeAndRetriesAreIdempotent() throws IOException {
		assertThat(this.api.postJson("/api/capture", capture("text", "seed")).status()).isIn(200, 201);
		try (SseRecorder others = SseRecorder.open(this.port, "observer-client-01", null)) {
			Reply once = this.api.postJson("/api/capture", capture("text", "only once", "date", "2026-10-16", "time", "11:11"),
					"Idempotency-Key", "capture-key-0001");
			Reply again = this.api.postJson("/api/capture",
					capture("text", "only once", "date", "2026-10-16", "time", "11:11"), "Idempotency-Key",
					"capture-key-0001");
			assertThat(once.status()).isEqualTo(200);
			assertThat(again.text()).isEqualTo(once.text());
			assertThat(disk("Inbox.md")).containsOnlyOnce("only once");
			others.awaitEvent("file.changed");
			JsonNode event = others.frames()
				.stream()
				.filter((f) -> f.event().equals("file.changed"))
				.reduce((a, b) -> b)
				.orElseThrow()
				.data();
			assertThat(event.get("file").get("path").asString()).isEqualTo("Inbox.md");
			assertThat(event.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
		}
	}

	@Test
	void aShortcutNeedsItsOwnClientIdAndNothingCrossOrigin() {
		Reply missing = this.api.postJson("/api/capture", capture("text", "x"), "X-Client-Id", null);
		assertThat(missing.problem(403)).isEqualTo("client-id-required");
		assertThat(this.api.postJson("/api/capture", capture("text", "x"), "Origin", "https://evil.example").problem(403))
			.isEqualTo("cross-origin");
		assertThat(this.api.postBytes("/api/capture/file?name=a.png", new byte[] { 1 }, "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		// What an iOS Shortcut sends: no Origin, no Sec-Fetch-*, its own client id.
		assertThat(this.api.postJson("/api/capture", capture("text", "from the Share Sheet"), "X-Client-Id",
				"ios-shortcut-capture")
			.status()).isIn(200, 201);
	}

	@Test
	void invalidCapturesAreBadRequests() {
		for (Map<String, Object> body : List.of(capture("text", "  "), capture(), capture("text", "x", "date", "16/10/2026"),
				capture("text", "x", "time", "25:99"), capture("text", "x", "tz", "Mars/Olympus"),
				capture("text", "x", "target", "elsewhere"), capture("url", "https://x.example/" + "a".repeat(5000)))) {
			assertThat(this.api.postJson("/api/capture", body).problem(400)).as(body.toString()).isEqualTo("bad-request");
		}
		assertThat(this.api.postBytes("/api/capture/file", new byte[] { 1 }).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.postBytes("/api/capture/file?name=a.png&target=nowhere", new byte[] { 1 }).problem(400))
			.isEqualTo("bad-request");
	}

	@Test
	void aCapturedFileIsStoredAsAnAttachmentAndEmbedded() throws IOException {
		JsonNode result = this.api
			.postBytes("/api/capture/file?name=" + Api.enc("IMG 0001.jpg") + "&text=" + Api.enc("Whiteboard")
					+ "&target=daily&date=2026-12-01&time=16:20", new byte[] { (byte) 0xFF, (byte) 0xD8, 1, 2 })
			.ok(201);
		assertThat(result.get("file").get("path").asString()).isEqualTo("Daily/2026-12-01.md");
		JsonNode attachment = result.get("attachment");
		assertThat(attachment.get("path").asString()).isEqualTo("Attachments/IMG 0001.jpg");
		assertThat(attachment.get("kind").asString()).isEqualTo("image");
		assertThat(disk("Daily/2026-12-01.md")).isEqualTo("- 16:20 Whiteboard\n  ![[IMG 0001.jpg]]\n");
		assertThat(Files.readAllBytes(vault.resolve("Attachments/IMG 0001.jpg"))).hasSize(4);
	}

	@Test
	void theCapturePageIsAClientRouteAndALostShareGoesThere() {
		Reply page = this.api.get("/capture?share=x");
		assertThat(page.status()).isEqualTo(200);
		assertThat(page.header("Content-Type")).startsWith("text/html");
		Reply share = this.api.postBytes("/capture/share", "title=x".getBytes(StandardCharsets.UTF_8), "X-Client-Id",
				null);
		assertThat(share.status()).isEqualTo(303);
		assertThat(share.header("Location")).isEqualTo("/capture?share=lost");
		assertThat(disk0("Inbox.md")).doesNotContain("title=x");
	}

	private String disk0(String path) {
		try {
			return disk(path);
		}
		catch (IOException ex) {
			return "";
		}
	}

}
