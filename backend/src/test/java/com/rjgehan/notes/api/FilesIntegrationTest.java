package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.function.Function;
import java.util.stream.Stream;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.RawHttp;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.vault.VaultLocks;
import com.rjgehan.notes.vault.VaultPaths;
import com.rjgehan.notes.watch.VaultReconciler;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Text files, path safety, raw serving and the JSON body limit (DESIGN §8.1 integration items 1, 2, 5 and 13).
 */
@NotesIntegrationTest
class FilesIntegrationTest {

	private static final String COMMIT = "0123456789abcdef0123456789abcdef01234567";

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
	VaultLocks locks;

	@Autowired
	VaultReconciler reconciler;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private JsonNode create(String path, String content) {
		return this.api.postJson("/api/files", Map.of("path", path, "content", content)).ok(201);
	}

	private Reply save(String path, String content, String baseVersion) {
		return this.api.putJson("/api/files?path=" + Api.enc(path), Map.of("content", content, "baseVersion", baseVersion));
	}

	private JsonNode status() {
		return this.api.get("/api/status").ok(200);
	}

	// ---------------------------------------------------------------- item 1: the save protocol

	@Test
	void createReadSaveConflictAndSaveWithTheNewBase() {
		JsonNode created = create("Flow/Plan.md", "# Plan\n");
		assertThat(created.get("created").asBoolean()).isTrue();
		assertThat(created.get("createdFolders").get(0).asString()).isEqualTo("Flow");
		JsonNode file = created.get("file");
		assertThat(file.get("kind").asString()).isEqualTo("note");
		assertThat(file.get("basename").asString()).isEqualTo("Plan");
		assertThat(file.get("extension").asString()).isEqualTo("md");
		assertThat(file.get("aliases").isEmpty()).isTrue();
		String v1 = file.get("version").asString();
		assertThat(v1).matches("[0-9a-f]{40}");

		Reply read = this.api.get("/api/files?path=" + Api.enc("Flow/Plan.md"));
		JsonNode text = read.ok(200);
		assertThat(read.header("Content-Type")).startsWith("application/json");
		assertThat(text.get("path").asString()).isEqualTo("Flow/Plan.md");
		assertThat(text.get("content").asString()).isEqualTo("# Plan\n");
		assertThat(text.get("version").asString()).isEqualTo(v1);
		assertThat(text.get("size").asLong()).isEqualTo(7);
		assertThat(text.get("mtime").asString()).matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z");
		assertThat(text.get("lossy").asBoolean()).isFalse();

		Reply saved = save("Flow/Plan.md", "# Plan\n\nv2\n", v1);
		String v2 = saved.ok(200).get("file").get("version").asString();
		assertThat(saved.json().get("created").asBoolean()).isFalse();
		assertThat(saved.json().get("createdFolders").isEmpty()).isTrue();
		assertThat(v2).isNotEqualTo(v1);

		Reply stale = save("Flow/Plan.md", "mine\n", v1);
		assertThat(stale.problem(409)).isEqualTo("version-conflict");
		JsonNode problem = stale.json();
		assertThat(problem.get("title").asString()).isEqualTo("Version conflict");
		assertThat(problem.get("instance").asString()).isEqualTo("/api/files");
		assertThat(problem.get("path").asString()).isEqualTo("Flow/Plan.md");
		assertThat(problem.get("currentVersion").asString()).isEqualTo(v2);
		assertThat(problem.get("currentContent").asString()).isEqualTo("# Plan\n\nv2\n");
		assertThat(problem.get("currentMtime").asString()).endsWith("Z");
		assertThat(problem.get("movedTo").isNull()).isTrue();

		JsonNode merged = save("Flow/Plan.md", "# Plan\n\nmerged\n", v2).ok(200);
		assertThat(this.api.get("/api/files?path=" + Api.enc("Flow/Plan.md")).json().get("content").asString())
			.isEqualTo("# Plan\n\nmerged\n");
		assertThat(merged.get("file").get("version").asString()).isNotEqualTo(v2);
	}

	@Test
	void aRetriedSaveSucceedsAndANoOpSaveMakesNoCommitAndNoEvent() {
		String v1 = create("Retry/Note.md", "one\n").get("file").get("version").asString();
		String v2 = save("Retry/Note.md", "two\n", v1).ok(200).get("file").get("version").asString();
		// The response to the save was "lost": the client retries with its old base.
		JsonNode retried = save("Retry/Note.md", "two\n", v1).ok(200);
		assertThat(retried.get("file").get("version").asString()).isEqualTo(v2);

		String other = create("Retry/Other.md", "x\n").get("file").get("version").asString();
		this.api.postEmpty("/api/history/commit").ok(200);
		int commits = history("Retry/Note.md").size();
		String head = status().get("git").get("head").asString();

		try (SseRecorder events = SseRecorder.open(this.port, "observer-0001", null)) {
			JsonNode noOp = save("Retry/Note.md", "two\n", v2).ok(200);
			assertThat(noOp.get("file").get("version").asString()).isEqualTo(v2);
			assertThat(this.api.get("/api/history?path=" + Api.enc("Retry/Note.md")).json().get("pending").asBoolean())
				.isFalse();
			// A real save afterwards proves the stream is live: only its event may arrive.
			save("Retry/Other.md", "y\n", other).ok(200);
			events.awaitEvent("file.changed");
			List<String> changed = events.frames()
				.stream()
				.filter((frame) -> frame.event().equals("file.changed"))
				.map((frame) -> frame.data().get("file").get("path").asString())
				.toList();
			assertThat(changed).containsExactly("Retry/Other.md");
		}
		this.api.postEmpty("/api/history/commit").ok(200);
		assertThat(status().get("git").get("head").asString()).isNotEqualTo(head);
		assertThat(history("Retry/Note.md")).hasSize(commits);
		assertThat(history("Retry/Other.md").get(0)).isEqualTo("Update Retry/Other.md");
	}

	private List<String> history(String path) {
		List<String> messages = new ArrayList<>();
		this.api.get("/api/history?path=" + Api.enc(path))
			.ok(200)
			.get("entries")
			.forEach((entry) -> messages.add(entry.get("message").asString()));
		return messages;
	}

	@Test
	void readsAreSideEffectFree() throws IOException {
		String indexed = create("Quiet/Note.md", "indexed\n").get("file").get("version").asString();
		this.api.postEmpty("/api/history/commit").ok(200);
		Files.writeString(vault.resolve("Quiet/Note.md"), "changed outside\n");
		String head = this.api.get("/api/tree").ok(200).get("eventId").asString();
		try (SseRecorder events = SseRecorder.open(this.port, "quiet-observer-1", head)) {
			JsonNode read = this.api.get("/api/files?path=" + Api.enc("Quiet/Note.md")).ok(200);
			assertThat(read.get("content").asString()).isEqualTo("changed outside\n");
			assertThat(read.get("version").asString()).isNotEqualTo(indexed);
			assertThat(this.api.get("/api/files/raw?path=" + Api.enc("Quiet/Note.md")).text())
				.isEqualTo("changed outside\n");
			this.api.get("/api/notes/meta?path=" + Api.enc("Quiet/Note.md")).ok(200);
			this.api.get("/api/notes/backlinks?unlinked=true&path=" + Api.enc("Quiet/Note.md")).ok(200);
			this.api.get("/api/search?q=changed").ok(200);
			this.api.get("/api/history?path=" + Api.enc("Quiet/Note.md")).ok(200);
			create("Quiet/Marker.md", "");
			events.awaitEvent("file.created");
			assertThat(events.eventNames()).containsExactly("file.created");
		}
		JsonNode tree = this.api.get("/api/tree").ok(200);
		assertThat(tree.get("files").values()
			.stream()
			.filter((file) -> file.get("path").asString().equals("Quiet/Note.md"))
			.findFirst()
			.orElseThrow()
			.get("version")
			.asString()).isEqualTo(indexed);
		assertThat(this.api.get("/api/history?path=" + Api.enc("Quiet/Note.md")).json().get("pending").asBoolean())
			.isFalse();
	}

	@Test
	void aLockThatCannotBeTakenGivesBusyWithRetryAfter() throws Exception {
		String version = create("Busy/Note.md", "x").get("file").get("version").asString();
		CountDownLatch held = new CountDownLatch(1);
		CountDownLatch release = new CountDownLatch(1);
		Thread holder = Thread.ofVirtual().start(() -> {
			try (VaultLocks.Held write = this.locks.write()) {
				held.countDown();
				release.await();
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		});
		try {
			held.await();
			Reply busy = save("Busy/Note.md", "y", version);
			assertThat(busy.problem(503)).isEqualTo("busy");
			assertThat(busy.json().get("title").asString()).isEqualTo("Busy, retry");
			assertThat(busy.header("Retry-After")).isEqualTo("1");
		}
		finally {
			release.countDown();
			holder.join();
		}
		assertThat(save("Busy/Note.md", "y", version).status()).isEqualTo(200);
	}

	@Test
	void missingFilesConflictWithNullCurrentValuesAndPutCreates() {
		Map<String, Object> body = new HashMap<>();
		body.put("content", "x");
		body.put("baseVersion", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
		Reply response = this.api.putJson("/api/files?path=Gone.md", body);
		assertThat(response.problem(409)).isEqualTo("version-conflict");
		for (String field : new String[] { "currentVersion", "currentContent", "currentMtime", "movedTo" }) {
			assertThat(response.json().has(field)).as(field).isTrue();
			assertThat(response.json().get(field).isNull()).as(field).isTrue();
		}
		Reply recreated = this.api.putJson("/api/files?path=" + Api.enc("New Folder/Gone.md"),
				"{\"content\":\"back\",\"baseVersion\":null}");
		assertThat(recreated.ok(201).get("created").asBoolean()).isTrue();
		assertThat(recreated.json().get("createdFolders").get(0).asString()).isEqualTo("New Folder");
		assertThat(this.api.putJson("/api/files?path=" + Api.enc("New Folder/Gone.md"), "{\"content\":\"other\"}")
			.problem(409)).isEqualTo("version-conflict");
	}

	@Test
	void renameModeIdempotencyKeysAndCaseCollisions() {
		create("Untitled.md", "");
		Reply renamed = this.api.postJson("/api/files",
				Map.of("path", "Untitled.md", "content", "", "onConflict", "rename"), "Idempotency-Key", "key-0000-0001");
		assertThat(renamed.ok(201).get("file").get("path").asString()).isEqualTo("Untitled 1.md");
		assertThat(renamed.header("Location")).isEqualTo("/api/files?path=Untitled%201.md");
		Reply replay = this.api.postJson("/api/files",
				Map.of("path", "Untitled.md", "content", "", "onConflict", "rename"), "Idempotency-Key", "key-0000-0001");
		assertThat(replay.ok(201).get("file").get("path").asString()).isEqualTo("Untitled 1.md");
		assertThat(Files.exists(vault.resolve("Untitled 2.md"))).isFalse();

		Reply fail = this.api.postJson("/api/files", Map.of("path", "untitled.md"));
		assertThat(fail.problem(409)).isEqualTo("case-collision");
		assertThat(fail.json().get("existingPath").asString()).isEqualTo("Untitled.md");
		Reply exists = this.api.postJson("/api/files", Map.of("path", "Untitled.md"));
		assertThat(exists.problem(409)).isEqualTo("already-exists");
		assertThat(exists.json().get("existingPath").asString()).isEqualTo("Untitled.md");
		Reply badKey = this.api.postJson("/api/files", Map.of("path", "Keyed.md"), "Idempotency-Key", "short");
		assertThat(badKey.problem(400)).isEqualTo("bad-request");
	}

	@Test
	void implicitParentsResolveCaseInsensitivelyAndAFileParentIsATypeMismatch() {
		create("Daily/Existing.md", "");
		JsonNode created = create("daily/New.md", "");
		assertThat(created.get("file").get("path").asString()).isEqualTo("Daily/New.md");
		assertThat(created.get("createdFolders").isEmpty()).isTrue();
		Reply underFile = this.api.postJson("/api/files", Map.of("path", "Daily/Existing.md/x.md"));
		assertThat(underFile.problem(409)).isEqualTo("type-mismatch");
		assertThat(underFile.json().get("expected").asString()).isEqualTo("folder");
		Reply folderAsFile = this.api.get("/api/files?path=Daily");
		assertThat(folderAsFile.problem(409)).isEqualTo("type-mismatch");
		assertThat(folderAsFile.json().get("expected").asString()).isEqualTo("file");
		Reply deleteFolderAsFile = this.api.delete("/api/files?path=Daily");
		assertThat(deleteFolderAsFile.problem(409)).isEqualTo("type-mismatch");
		Reply deleteFileAsFolder = this.api.delete("/api/folders?path=" + Api.enc("Daily/New.md"));
		assertThat(deleteFileAsFolder.problem(409)).isEqualTo("type-mismatch");
		assertThat(deleteFileAsFolder.json().get("expected").asString()).isEqualTo("folder");
	}

	@Test
	void foldersAreCreatedWithTheirParents() {
		Reply created = this.api.postJson("/api/folders", Map.of("path", "Deep/Er/Est"));
		JsonNode result = created.ok(201);
		assertThat(result.get("folder").get("path").asString()).isEqualTo("Deep/Er/Est");
		assertThat(result.get("folder").get("name").asString()).isEqualTo("Est");
		assertThat(result.get("createdFolders").values().stream().map(JsonNode::asString))
			.containsExactly("Deep", "Deep/Er", "Deep/Er/Est");
		assertThat(this.api.postJson("/api/folders", Map.of("path", "Deep/Er/Est")).problem(409))
			.isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/folders", Map.of("path", "deep/er/EST")).problem(409))
			.isEqualTo("case-collision");
		assertThat(this.api.postJson("/api/folders", Map.of("path", "Bad#Folder")).problem(400))
			.isEqualTo("invalid-name");
	}

	@Test
	void requestBodiesAreValidated() {
		assertThat(this.api.postJson("/api/files", Map.of("path", "Lenient.md", "content", "x", "futureField", true))
			.status()).isEqualTo(201);
		Reply missing = this.api.postJson("/api/files", Map.of("content", "no path"));
		assertThat(missing.problem(400)).isEqualTo("bad-request");
		assertThat(missing.json().get("errors").get(0).get("field").asString()).isEqualTo("path");
		Reply malformed = this.api.postJson("/api/files", "{not json");
		assertThat(malformed.problem(400)).isEqualTo("bad-request");
		assertThat(malformed.json().get("errors").isArray()).isTrue();
		Reply badEnum = this.api.postJson("/api/files", Map.of("path", "Enum.md", "onConflict", "overwrite"));
		assertThat(badEnum.problem(400)).isEqualTo("bad-request");
		Reply notJson = this.api.putBytes("/api/files?path=x.md", "{}".getBytes(StandardCharsets.UTF_8));
		assertThat(notJson.problem(415)).isEqualTo("unsupported-media-type");
		Reply notText = this.api.postJson("/api/files", Map.of("path", "x.png"));
		assertThat(notText.problem(415)).isEqualTo("not-text");
		assertThat(notText.json().get("kind").asString()).isEqualTo("image");
		Reply method = this.api.postJson("/api/tree", Map.of());
		assertThat(method.problem(405)).isEqualTo("method-not-allowed");
	}

	// ---------------------------------------------------------------- item 2: path safety

	private static final List<String> UNSAFE = List.of("../x.md", "a/../../x.md", "/abs.md", "a//b.md", "a\\b.md",
			"a/./b.md", "x.md/", "a\u0001b.md", "a/" + "n".repeat(256) + ".md");

	private static final List<String> RESERVED = List.of(".git/config", ".notesapp/settings.json", ".trash/x.md",
			"a/.hidden/b.md", ".env");

	/** Every endpoint that takes a path, as a request with that path in the right place. */
	private Map<String, Function<String, Reply>> endpoints(String trashId) {
		Map<String, Function<String, Reply>> endpoints = new LinkedHashMap<>();
		endpoints.put("GET /api/files", (p) -> this.api.get("/api/files?path=" + Api.enc(p)));
		endpoints.put("PUT /api/files",
				(p) -> this.api.putJson("/api/files?path=" + Api.enc(p), "{\"content\":\"x\",\"baseVersion\":null}"));
		endpoints.put("POST /api/files", (p) -> this.api.postJson("/api/files", Map.of("path", p)));
		endpoints.put("DELETE /api/files", (p) -> this.api.delete("/api/files?path=" + Api.enc(p)));
		endpoints.put("GET /api/files/raw", (p) -> this.api.get("/api/files/raw?path=" + Api.enc(p)));
		endpoints.put("PUT /api/files/raw",
				(p) -> this.api.putBytes("/api/files/raw?path=" + Api.enc(p), new byte[] { 1 }));
		endpoints.put("POST /api/attachments (source)",
				(p) -> this.api.postBytes("/api/attachments?name=a.png&source=" + Api.enc(p), new byte[] { 1 }));
		endpoints.put("POST /api/folders", (p) -> this.api.postJson("/api/folders", Map.of("path", p)));
		endpoints.put("DELETE /api/folders", (p) -> this.api.delete("/api/folders?path=" + Api.enc(p)));
		endpoints.put("POST /api/move (from)", (p) -> this.api.postJson("/api/move", Map.of("from", p, "to", "t.md")));
		endpoints.put("POST /api/move (to)",
				(p) -> this.api.postJson("/api/move", Map.of("from", "Safe/Exists.md", "to", p)));
		endpoints.put("GET /api/notes/meta", (p) -> this.api.get("/api/notes/meta?path=" + Api.enc(p)));
		endpoints.put("GET /api/notes/backlinks", (p) -> this.api.get("/api/notes/backlinks?path=" + Api.enc(p)));
		endpoints.put("POST /api/links/resolve",
				(p) -> this.api.postJson("/api/links/resolve", Map.of("source", p, "targets", List.of("x"))));
		endpoints.put("GET /api/history", (p) -> this.api.get("/api/history?path=" + Api.enc(p)));
		endpoints.put("GET /api/history/content",
				(p) -> this.api.get("/api/history/content?path=" + Api.enc(p) + "&commit=" + COMMIT));
		endpoints.put("GET /api/history/raw",
				(p) -> this.api.get("/api/history/raw?path=" + Api.enc(p) + "&commit=" + COMMIT));
		endpoints.put("POST /api/history/restore (path)", (p) -> this.api.postJson("/api/history/restore",
				Map.of("path", p, "commit", COMMIT, "baseVersion", "x")));
		endpoints.put("POST /api/history/restore (sourcePath)", (p) -> this.api.postJson("/api/history/restore",
				Map.of("path", "Safe/Exists.md", "sourcePath", p, "commit", COMMIT, "baseVersion", "x")));
		endpoints.put("POST /api/trash/{id}/restore (to)",
				(p) -> this.api.postJson("/api/trash/" + trashId + "/restore", Map.of("to", p)));
		return endpoints;
	}

	static Stream<Arguments> unsafePaths() {
		return Stream.concat(UNSAFE.stream().map((path) -> Arguments.of(path, 400, "invalid-path")),
				RESERVED.stream().map((path) -> Arguments.of(path, 403, "reserved-path")));
	}

	@ParameterizedTest(name = "{0} gives {2}")
	@MethodSource("unsafePaths")
	void everyEndpointThatTakesAPathRejectsTraversalAndReservedPaths(String path, int status, String code) {
		if (this.api.get("/api/files?path=" + Api.enc("Safe/Exists.md")).status() == 404) {
			create("Safe/Exists.md", "safe\n");
		}
		String trashed = create("Safe/Trashed.md", "").get("file").get("path").asString();
		String trashId = this.api.delete("/api/files?path=" + Api.enc(trashed)).ok(200).get("id").asString();
		List<String> failures = new ArrayList<>();
		endpoints(trashId).forEach((name, request) -> {
			Reply reply = request.apply(path);
			String actual = reply.json().path("code").asString("");
			if (reply.status() != status || !actual.equals(code)) {
				failures.add(name + " → " + reply.status() + " " + actual);
			}
		});
		assertThat(failures).as("endpoints that accepted %s", path).isEmpty();
		assertThat(Files.exists(vault.resolve("x.md"))).isFalse();
	}

	@ParameterizedTest
	@ValueSource(strings = { "What?.md", "Plan #2 [draft].md", "Meeting 10:30.md", "50%% done.md", "con.md" })
	void anExistingNameThatBreaksTheNewNameRulesIsFullyAddressable(String name) throws IOException {
		Assumptions.assumeTrue(!VaultPaths.isWindows() || name.matches("[^?:]*") && !name.equals("con.md"),
				"not a valid file name on Windows");
		Files.writeString(vault.resolve(name), "external\n");
		assertThat(this.api.postJson("/api/files", Map.of("path", "Sub/" + name)).problem(400))
			.isEqualTo("invalid-name");
		// GETs never index anything; with the watcher off here, the rescan finds the new file.
		assertThat(this.api.get("/api/files?path=" + Api.enc(name)).problem(404)).isEqualTo("not-found");
		this.reconciler.fullRescan(false);

		JsonNode read = this.api.get("/api/files?path=" + Api.enc(name)).ok(200);
		assertThat(read.get("content").asString()).isEqualTo("external\n");
		String saved = save(name, "edited\n", read.get("version").asString()).ok(200).get("file").get("version")
			.asString();
		assertThat(Files.readString(vault.resolve(name))).isEqualTo("edited\n");

		String trashId = this.api.delete("/api/files?path=" + Api.enc(name)).ok(200).get("id").asString();
		assertThat(Files.exists(vault.resolve(name))).isFalse();
		JsonNode restored = this.api.postEmpty("/api/trash/" + trashId + "/restore").ok(200);
		assertThat(restored.get("path").asString()).isEqualTo(name);
		assertThat(restored.get("files").get(0).get("version").asString()).isEqualTo(saved);

		String target = "Renamed " + Math.abs(name.hashCode()) + ".md";
		JsonNode moved = this.api.postJson("/api/move", Map.of("from", name, "to", target)).ok(200);
		assertThat(moved.get("moved").get(0).get("from").asString()).isEqualTo(name);
		assertThat(Files.readString(vault.resolve(target))).isEqualTo("edited\n");
	}

	// ---------------------------------------------------------------- item 5: raw serving

	@Test
	void rawFilesAreServedSafely() {
		byte[] png = new byte[64];
		for (int i = 0; i < png.length; i++) {
			png[i] = (byte) i;
		}
		JsonNode file = this.api.putBytes("/api/files/raw?path=" + Api.enc("Pics/pic.png"), png).ok(201).get("file");
		assertThat(file.get("kind").asString()).isEqualTo("image");
		assertThat(file.get("version").isNull()).isTrue();

		Reply raw = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png"));
		assertThat(raw.status()).isEqualTo(200);
		assertThat(raw.body()).isEqualTo(png);
		assertThat(raw.header("Content-Type")).isEqualTo("image/png");
		assertThat(raw.header("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(raw.header("Content-Security-Policy")).isEqualTo("sandbox; default-src 'none'; img-src 'self' data:; "
				+ "media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
		assertThat(raw.header("X-Frame-Options")).isEqualTo("SAMEORIGIN");
		assertThat(raw.header("Cross-Origin-Resource-Policy")).isEqualTo("same-origin");
		assertThat(raw.header("Content-Disposition")).isEqualTo("inline; filename*=UTF-8''pic.png");
		assertThat(raw.header("Cache-Control")).isEqualTo("no-cache");
		assertThat(raw.header("Accept-Ranges")).isEqualTo("bytes");
		assertThat(raw.header("ETag")).isEqualTo("W/\"" + Api.rawToken(file) + "\"");
		assertThat(raw.header("Last-Modified")).isNotBlank();
		assertThat(raw.header("X-Notes-Build")).isEqualTo("dev");

		Reply range = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png"), "Range", "bytes=0-9");
		assertThat(range.status()).isEqualTo(206);
		assertThat(range.body()).hasSize(10).isEqualTo(Arrays.copyOf(png, 10));
		assertThat(range.header("Content-Range")).isEqualTo("bytes 0-9/64");
		assertThat(this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png"), "Range", "bytes=100-200").status())
			.isEqualTo(416);

		Reply conditional = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png"), "If-None-Match",
				raw.header("ETag"));
		assertThat(conditional.status()).isEqualTo(304);
		assertThat(conditional.body()).isEmpty();

		Reply immutable = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png") + "&v=" + Api.rawToken(file));
		assertThat(immutable.header("Cache-Control")).isEqualTo("private, max-age=31536000, immutable");
		Reply stale = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png") + "&v=1-2");
		assertThat(stale.header("Cache-Control")).isEqualTo("no-cache");
		Reply download = this.api.get("/api/files/raw?path=" + Api.enc("Pics/pic.png") + "&download=true");
		assertThat(download.header("Content-Disposition")).isEqualTo("attachment; filename*=UTF-8''pic.png");

		assertThat(this.api.get("/api/files/raw?path=Pics").problem(409)).isEqualTo("type-mismatch");
		assertThat(this.api.get("/api/files/raw?path=" + Api.enc("Pics/none.png")).problem(404)).isEqualTo("not-found");
	}

	@Test
	void contentTypesNeverRenderActiveContent() {
		byte[] svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"
			.getBytes(StandardCharsets.UTF_8);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Types/x.svg"), svg).ok(201);
		Reply served = this.api.get("/api/files/raw?path=" + Api.enc("Types/x.svg"));
		assertThat(served.header("Content-Type")).isEqualTo("image/svg+xml");
		assertThat(served.header("Content-Disposition")).startsWith("inline;");
		assertThat(served.header("Content-Security-Policy")).startsWith("sandbox; default-src 'none';");

		for (String name : List.of("page.html", "page.xhtml", "data.xml", "app.js", "module.mjs")) {
			this.api.putBytes("/api/files/raw?path=" + Api.enc("Types/" + name), "<b>x</b>".getBytes(StandardCharsets.UTF_8))
				.ok(201);
			Reply html = this.api.get("/api/files/raw?path=" + Api.enc("Types/" + name));
			assertThat(html.header("Content-Type")).as(name).isEqualTo("application/octet-stream");
			assertThat(html.header("Content-Disposition")).as(name).startsWith("attachment;");
		}

		this.api.postJson("/api/files", Map.of("path", "Types/Note é.md", "content", "# Hi\n")).ok(201);
		Reply note = this.api.get("/api/files/raw?path=" + Api.enc("Types/Note é.md"));
		assertThat(MediaType.parseMediaType(note.header("Content-Type")))
			.isEqualTo(new MediaType("text", "plain", StandardCharsets.UTF_8));
		assertThat(note.header("Content-Disposition")).isEqualTo("inline; filename*=UTF-8''Note%20%C3%A9.md");
		this.api.postJson("/api/files", Map.of("path", "Types/rows.csv", "content", "a,b\n")).ok(201);
		Reply csv = this.api.get("/api/files/raw?path=" + Api.enc("Types/rows.csv"));
		assertThat(MediaType.parseMediaType(csv.header("Content-Type")))
			.isEqualTo(new MediaType("text", "csv", StandardCharsets.UTF_8));
		assertThat(csv.header("Content-Disposition")).startsWith("attachment;");

		this.api.putBytes("/api/files/raw?path=" + Api.enc("Types/doc.pdf"), "%PDF-1.7".getBytes(StandardCharsets.UTF_8))
			.ok(201);
		Reply pdf = this.api.get("/api/files/raw?path=" + Api.enc("Types/doc.pdf"));
		assertThat(pdf.header("Content-Type")).isEqualTo("application/pdf");
		assertThat(pdf.header("Content-Disposition")).startsWith("inline;");
		assertThat(pdf.header("Content-Security-Policy")).isEqualTo("default-src 'none'; frame-ancestors 'self'");
	}

	@Test
	void uploadConflictModes() {
		byte[] png = { 1, 2, 3, 4 };
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/pic.png"), png).ok(201);
		assertThat(this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/pic.png"), png).problem(409))
			.isEqualTo("already-exists");
		assertThat(this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/PIC.png") + "&onConflict=overwrite", png)
			.problem(409)).isEqualTo("case-collision");
		JsonNode renamed = this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/pic.png") + "&onConflict=rename", png)
			.ok(201);
		assertThat(renamed.get("file").get("path").asString()).isEqualTo("Up/pic 1.png");
		JsonNode overwritten = this.api
			.putBytes("/api/files/raw?path=" + Api.enc("Up/pic.png") + "&onConflict=overwrite", new byte[] { 9 })
			.ok(200);
		assertThat(overwritten.get("created").asBoolean()).isFalse();
		assertThat(overwritten.get("file").get("size").asLong()).isEqualTo(1);
		assertThat(this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/pic.png") + "&onConflict=replace", png)
			.problem(400)).isEqualTo("bad-request");

		create("Up/note.md", "hello");
		assertThat(this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/note.md") + "&onConflict=overwrite",
				"x".getBytes(StandardCharsets.UTF_8))
			.problem(400)).isEqualTo("bad-request");
		JsonNode text = this.api.putBytes("/api/files/raw?path=" + Api.enc("Up/data.json"),
				"{\"a\":1}".getBytes(StandardCharsets.UTF_8))
			.ok(201);
		assertThat(text.get("file").get("kind").asString()).isEqualTo("text");
		assertThat(text.get("file").get("version").asString()).matches("[0-9a-f]{40}");
	}

	@Test
	void symlinksAreNeverServed() throws IOException {
		Path outside = Files.createTempDirectory("outside");
		Files.writeString(outside.resolve("secret.md"), "secret");
		try {
			Files.createSymbolicLink(vault.resolve("link.md"), outside.resolve("secret.md"));
		}
		catch (FileSystemException | UnsupportedOperationException ex) {
			Assumptions.abort("symbolic links cannot be created here: " + ex.getMessage());
		}
		assertThat(this.api.get("/api/files/raw?path=link.md").problem(404)).isEqualTo("not-found");
		assertThat(this.api.get("/api/files?path=link.md").problem(404)).isEqualTo("not-found");
		assertThat(this.api.get("/api/tree").text()).doesNotContain("link.md");
	}

	// ---------------------------------------------------------------- item 13: the JSON body limit

	@Test
	void anOversizedJsonBodyIsRejectedBeforeItIsRead() throws IOException {
		// The body is announced but never sent: answering at all proves the server did not try to read it.
		RawHttp.Response response = RawHttp.exchange(this.port, """
				PUT /api/files?path=huge.md HTTP/1.1
				Host: localhost:%d
				X-Client-Id: %s
				Content-Type: application/json
				Content-Length: %d
				Expect: 100-continue
				Connection: close
				""".formatted(this.port, Api.CLIENT_ID, 16L * 1024 * 1024 + 1));
		assertThat(response.status()).isEqualTo(413);
		assertThat(response.headers().get("content-type")).startsWith("application/problem+json");
		JsonNode problem = Api.JSON.readTree(response.body());
		assertThat(problem.get("code").asString()).isEqualTo("too-large");
		assertThat(problem.get("limit").asLong()).isEqualTo(16L * 1024 * 1024);
		assertThat(Files.exists(vault.resolve("huge.md"))).isFalse();
	}

	@Test
	void aChunkedJsonBodyIsCutOffAtTheLimit() throws IOException {
		try (RawHttp http = new RawHttp(this.port, Duration.ofSeconds(30))) {
			http.sendHead("""
					PUT /api/files?path=chunked.md HTTP/1.1
					Host: localhost:%d
					X-Client-Id: %s
					Content-Type: application/json
					Transfer-Encoding: chunked
					""".formatted(this.port, Api.CLIENT_ID));
			byte[] chunk = "x".repeat(1024 * 1024).getBytes(StandardCharsets.US_ASCII);
			byte[] start = "{\"content\":\"".getBytes(StandardCharsets.US_ASCII);
			http.sendBody((Integer.toHexString(start.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
			http.sendBody(start);
			http.sendBody("\r\n".getBytes(StandardCharsets.US_ASCII));
			for (int i = 0; i < 17; i++) {
				http.sendBody((Integer.toHexString(chunk.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
				http.sendBody(chunk);
				http.sendBody("\r\n".getBytes(StandardCharsets.US_ASCII));
			}
			http.sendBody("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
			RawHttp.Response response = http.readResponse();
			assertThat(response.status()).isEqualTo(413);
			JsonNode problem = Api.JSON.readTree(response.body());
			assertThat(problem.get("code").asString()).isEqualTo("too-large");
			assertThat(problem.get("limit").asLong()).isEqualTo(16L * 1024 * 1024);
		}
		assertThat(Files.exists(vault.resolve("chunked.md"))).isFalse();
	}

	@Test
	void anOversizedJsonBodyThatIsSentIsRejected() {
		String huge = "{\"content\":\"" + "x".repeat(17 * 1024 * 1024) + "\",\"baseVersion\":null}";
		Reply response = this.api.putJson("/api/files?path=huge2.md", huge);
		assertThat(response.problem(413)).isEqualTo("too-large");
		assertThat(response.json().get("limit").asLong()).isEqualTo(16L * 1024 * 1024);
		assertThat(Files.exists(vault.resolve("huge2.md"))).isFalse();
		Reply tooLargeText = this.api.putJson("/api/files?path=big.md",
				Map.of("content", "y".repeat(5 * 1024 * 1024 + 1), "baseVersion", "x"));
		assertThat(tooLargeText.problem(413)).isEqualTo("too-large");
		assertThat(tooLargeText.json().get("limit").asLong()).isEqualTo(5L * 1024 * 1024);
	}

}
