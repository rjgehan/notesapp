package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.RawHttp;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.vaults.VaultRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Multiple vaults (ROADMAP item 37, DESIGN §5.38, API.md §38): the default vault keeps its unprefixed API, an extra
 * vault answers under {@code /api/v/<name>/}, and nothing one vault holds (files, search, links, history, trash, events,
 * settings, bookmarks, tasks) is visible in the other.
 */
@NotesIntegrationTest
class MultipleVaultsIntegrationTest {

	private static final String WORK = "/api/v/work";

	@TempDir
	static Path vault;

	@TempDir
	static Path vaults;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
		registry.add("notes.vaults.dir", () -> {
			try {
				Files.createDirectories(vaults.resolve("work"));
				// Not vaults: an invalid name, a hidden folder and a plain file.
				Files.createDirectories(vaults.resolve("Not A Vault"));
				Files.createDirectories(vaults.resolve(".hidden"));
				Files.writeString(vaults.resolve("notes.txt"), "not a vault");
			}
			catch (IOException ex) {
				throw new UncheckedIOException(ex);
			}
			return vaults.toString();
		});
	}

	@LocalServerPort
	int port;

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	@Autowired
	VaultRegistry registry;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
		awaitReady("work");
	}

	private void awaitReady(String name) {
		await().atMost(Duration.ofSeconds(60)).until(() -> {
			for (JsonNode vault : this.api.get("/api/vaults").ok(200).get("vaults")) {
				if (vault.get("name").asString().equals(name)) {
					assertThat(vault.get("state").asString()).isNotEqualTo("failed");
					return vault.get("state").asString().equals("ready");
				}
			}
			return false;
		});
		ConfigurableApplicationContext context = this.registry.context(name);
		assertThat(context).isNotNull();
		CommitBatcher theirs = context.getBean(CommitBatcher.class);
		await().atMost(Duration.ofSeconds(30)).until(() -> !theirs.isImporting());
	}

	private JsonNode create(String prefix, String path, String content) {
		return this.api.postJson(prefix + "/files", Map.of("path", path, "content", content)).ok(201);
	}

	private static List<String> paths(JsonNode tree) {
		List<String> paths = new ArrayList<>();
		tree.get("files").forEach((file) -> paths.add(file.get("path").asString()));
		return paths;
	}

	@Test
	void theVaultListShowsTheDefaultVaultAndTheValidFolders() {
		JsonNode list = this.api.get("/api/vaults").ok(200);
		assertThat(list.get("canCreate").asBoolean()).isTrue();
		JsonNode first = list.get("vaults").get(0);
		assertThat(first.get("name").asString()).isEqualTo("main");
		assertThat(first.get("isDefault").asBoolean()).isTrue();
		assertThat(first.get("url").asString()).isEqualTo("/");
		List<String> names = new ArrayList<>();
		list.get("vaults").forEach((vault) -> names.add(vault.get("name").asString()));
		assertThat(names).contains("work").doesNotContain("Not A Vault", ".hidden", "notes.txt");
		JsonNode work = list.get("vaults").get(names.indexOf("work"));
		assertThat(work.get("isDefault").asBoolean()).isFalse();
		assertThat(work.get("url").asString()).isEqualTo("/v/work/");
		// The default vault answers under its own name too, and the vault list is not a vault endpoint.
		assertThat(this.api.get("/api/v/main/tree").ok(200).get("files").size())
			.isEqualTo(this.api.get("/api/tree").ok(200).get("files").size());
		assertThat(this.api.get(WORK + "/vaults").status()).isEqualTo(404);
	}

	@Test
	void vaultsCanBeCreatedWithValidNewNamesOnly() {
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "Bad Name")).problem(400)).isEqualTo("invalid-name");
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "-dash")).problem(400)).isEqualTo("invalid-name");
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "..")).problem(400)).isEqualTo("invalid-name");
		assertThat(this.api.postJson("/api/vaults", Map.of()).problem(400)).isEqualTo("invalid-name");
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "main")).problem(409)).isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "work")).problem(409)).isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "play"), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");

		JsonNode created = this.api.postJson("/api/vaults", Map.of("name", "play")).ok(201);
		assertThat(created.get("name").asString()).isEqualTo("play");
		assertThat(created.get("url").asString()).isEqualTo("/v/play/");
		assertThat(Files.isDirectory(vaults.resolve("play"))).isTrue();
		awaitReady("play");
		// A new vault starts with its own welcome note and its own git repository.
		assertThat(paths(this.api.get("/api/v/play/tree").ok(200))).contains("Welcome.md");
		await().atMost(Duration.ofSeconds(30)).until(() -> Files.isDirectory(vaults.resolve("play/.git")));
		assertThat(this.api.postJson("/api/vaults", Map.of("name", "play")).problem(409)).isEqualTo("already-exists");
	}

	@Test
	void filesSearchAndLinksStayInTheirVault() {
		create("/api", "Shared.md", "# Shared\nmain kumquat\n");
		create(WORK, "Shared.md", "# Shared\nwork rambutan\n");
		create(WORK, "Only Work.md", "See [[Shared]] and [[Only Main]].\n");
		create("/api", "Only Main.md", "Main only.\n");

		assertThat(paths(this.api.get("/api/tree").ok(200))).contains("Shared.md", "Only Main.md")
			.doesNotContain("Only Work.md");
		assertThat(paths(this.api.get(WORK + "/tree").ok(200))).contains("Shared.md", "Only Work.md")
			.doesNotContain("Only Main.md");
		assertThat(this.api.get("/api/files?path=Shared.md").ok(200).get("content").asString()).contains("kumquat");
		assertThat(this.api.get(WORK + "/files?path=Shared.md").ok(200).get("content").asString()).contains("rambutan");
		assertThat(Files.exists(vaults.resolve("work/Only Work.md"))).isTrue();
		assertThat(Files.exists(vault.resolve("Only Work.md"))).isFalse();

		assertThat(this.api.get("/api/search?q=rambutan").ok(200).get("total").asInt()).isZero();
		assertThat(this.api.get(WORK + "/search?q=rambutan").ok(200).get("total").asInt()).isEqualTo(1);
		assertThat(this.api.get(WORK + "/search?q=kumquat").ok(200).get("total").asInt()).isZero();

		JsonNode mainBacklinks = this.api.get("/api/notes/backlinks?path=Shared.md").ok(200);
		assertThat(mainBacklinks.get("linked").size()).isZero();
		JsonNode workBacklinks = this.api.get(WORK + "/notes/backlinks?path=Shared.md").ok(200);
		assertThat(workBacklinks.get("linked").size()).isEqualTo(1);
		// [[Only Main]] does not resolve across vaults.
		JsonNode meta = this.api.get(WORK + "/notes/meta?path=" + Api.enc("Only Work.md")).ok(200);
		assertThat(meta.toString()).doesNotContain("\"Only Main.md\"");
	}

	@Test
	void historyAndTrashStayInTheirVault() {
		create(WORK, "Diary.md", "work diary\n");
		this.api.postEmpty(WORK + "/history/commit").ok(200);
		assertThat(this.api.get(WORK + "/history?path=Diary.md").ok(200).get("entries").size()).isPositive();
		assertThat(this.api.get("/api/history?path=Diary.md").ok(200).get("entries").size()).isZero();
		assertThat(Files.isDirectory(vaults.resolve("work/.git"))).isTrue();

		JsonNode deleted = this.api.delete(WORK + "/files?path=Diary.md").ok(200);
		String id = deleted.get("id").asString();
		assertThat(this.api.get(WORK + "/trash").ok(200).get("entries").toString()).contains(id);
		assertThat(this.api.get("/api/trash").ok(200).get("entries").toString()).doesNotContain(id);
		assertThat(this.api.postJson("/api/trash/" + id + "/restore", Map.of()).status()).isEqualTo(404);
		this.api.postJson(WORK + "/trash/" + id + "/restore", Map.of()).ok(200);
		assertThat(paths(this.api.get(WORK + "/tree").ok(200))).contains("Diary.md");
	}

	@Test
	void eventsReachOnlyTheVaultsOwnStream() {
		try (SseRecorder mainEvents = SseRecorder.open(this.port, "/api", "observer-main-01", null);
				SseRecorder workEvents = SseRecorder.open(this.port, WORK, "observer-work-01", null)) {
			create(WORK, "Evented.md", "x\n");
			workEvents.awaitFrames((frames) -> frames.stream()
				.anyMatch((f) -> f.event().equals("file.created") && f.data().toString().contains("Evented.md")));
			create("/api", "Marker.md", "y\n");
			mainEvents.awaitFrames((frames) -> frames.stream()
				.anyMatch((f) -> f.event().equals("file.created") && f.data().toString().contains("Marker.md")));
			assertThat(mainEvents.frames()).noneMatch((f) -> f.data().toString().contains("Evented.md"));
			assertThat(workEvents.frames()).noneMatch((f) -> f.data().toString().contains("Marker.md"));
		}
	}

	@Test
	void settingsBookmarksAndTasksStayInTheirVault() {
		JsonNode mainSettings = this.api.get("/api/settings").ok(200);
		JsonNode workSettings = this.api.get(WORK + "/settings").ok(200);
		tools.jackson.databind.node.ObjectNode changed = (tools.jackson.databind.node.ObjectNode) workSettings
			.get("settings")
			.deepCopy();
		((tools.jackson.databind.node.ObjectNode) changed.get("editor")).put("readableLineLength",
				!workSettings.get("settings").get("editor").get("readableLineLength").asBoolean());
		this.api.putJson(WORK + "/settings", Map.of("settings", changed, "baseVersion", workSettings.get("version")))
			.ok(200);
		assertThat(this.api.get("/api/settings").ok(200).get("settings"))
			.isEqualTo(mainSettings.get("settings"));
		assertThat(Files.exists(vaults.resolve("work/.notesapp/settings.json"))).isTrue();

		create(WORK, "Starred.md", "*\n");
		JsonNode bookmarks = this.api.get(WORK + "/bookmarks").ok(200);
		this.api.putJson(WORK + "/bookmarks", Map.of("items",
				List.of(Map.of("type", "file", "ctime", 1760616202120L, "path", "Starred.md")), "baseVersion",
				bookmarks.get("version").asString()))
			.ok(200);
		assertThat(this.api.get(WORK + "/bookmarks").ok(200).get("items").size()).isEqualTo(1);
		assertThat(this.api.get("/api/bookmarks").ok(200).get("items").toString()).doesNotContain("Starred.md");

		String listId = this.api.postJson(WORK + "/tasks/lists", Map.of("name", "Work list"))
			.ok(201)
			.get("lists")
			.get(0)
			.get("id")
			.asString();
		String taskId = this.api.postJson(WORK + "/tasks", Map.of("title", "Ship the vaults", "listId", listId))
			.ok(201)
			.get("task")
			.get("id")
			.asString();
		assertThat(this.api.get(WORK + "/tasks/" + taskId).ok(200).get("title").asString())
			.isEqualTo("Ship the vaults");
		assertThat(this.api.get("/api/tasks/" + taskId).status()).isEqualTo(404);
		assertThat(this.api.get("/api/tasks").ok(200).toString()).doesNotContain("Ship the vaults");
	}

	@Test
	void pathsCannotLeaveTheirVault() throws IOException {
		Files.writeString(vault.resolve("Secret.md"), "main secret\n");
		assertThat(this.api.get(WORK + "/files?path=" + Api.enc("../../" + vault.getFileName() + "/Secret.md"))
			.problem(400)).isEqualTo("invalid-path");
		assertThat(this.api.get(WORK + "/files?path=" + Api.enc("..%2FSecret.md")).status()).isIn(400, 403, 404);
		Reply absolute = this.api.get(WORK + "/files?path=" + Api.enc(vault.resolve("Secret.md").toString()));
		assertThat(absolute.status()).isIn(400, 403, 404);
		assertThat(absolute.text()).doesNotContain("main secret");
		// Unknown, malformed or disguised vault names never reach a vault.
		assertThat(this.api.get("/api/v/nope/tree").problem(404)).isEqualTo("vault-not-found");
		assertThat(this.api.get("/api/v/WORK/tree").status()).isEqualTo(404);
		assertThat(this.api.get("/api/v/%77ork/tree").status()).isEqualTo(404);
		assertThat(this.api.get("/api/v/work;x=1/tree").status()).isEqualTo(404);
		assertThat(this.api.get("/api/v/work%2Ftree").status()).isIn(400, 404);
		// The admission and CSRF rules hold under a vault prefix.
		assertThat(this.api.postJson(WORK + "/files", Map.of("path", "X.md"), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		assertThat(this.api.postJson(WORK + "/files", Map.of("path", "X.md"), "Origin", "https://evil.example")
			.problem(403)).isEqualTo("cross-origin");
		RawHttp.Response evil = RawHttp.exchange(this.port, """
				GET /api/v/work/tree HTTP/1.1
				Host: evil.example:%d
				Connection: close
				""".formatted(this.port));
		assertThat(evil.status()).isEqualTo(421);
		RawHttp.Response dotted = RawHttp.exchange(this.port, """
				GET /api/v/work/../../tree HTTP/1.1
				Host: localhost:%d
				Connection: close
				""".formatted(this.port));
		assertThat(dotted.status()).isIn(400, 404);
	}

}
