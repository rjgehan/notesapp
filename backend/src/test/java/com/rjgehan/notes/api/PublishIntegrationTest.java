package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.publish.PublishServer;
import com.rjgehan.notes.publish.SnapshotStore;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.RawHttp;
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

/**
 * Public publishing switched on (ROADMAP item 26, DESIGN §5.28, API.md §26): the publish API on the app, and the
 * separate publish server, which must answer with nothing but published snapshots. Every private thing a request to
 * it could try to reach (private notes, the API, the SPA, attachments no published note embeds, {@code .notesapp},
 * {@code .git}, other files in the snapshot folder) is a {@code 404}.
 */
@NotesIntegrationTest
class PublishIntegrationTest {

	private static final byte[] PNG = { (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3, 4 };

	private static final byte[] SECRET_PNG = { (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 9, 9, 9, 9 };

	@TempDir
	static Path vault;

	@TempDir
	static Path site;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.publish.enabled", "true",
				"notes.publish.port", "0", "notes.publish.base-url", "https://notes.example.ts.net:8443/"));
		registry.add("notes.publish.dir", () -> site.toString());
	}

	@LocalServerPort
	int port;

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	@Autowired
	PublishServer server;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private RawHttp.Response pub(String method, String target) throws Exception {
		return RawHttp.exchange(this.server.port(),
				method + " " + target + " HTTP/1.1\nHost: notes.example.ts.net\nConnection: close");
	}

	private String create(String path, String content) {
		this.api.postJson("/api/files", Map.of("path", path, "content", content)).ok(201);
		return path;
	}

	@Test
	void aPublishedNoteIsServedAsAStaticPageAndNothingElseIsReachable() throws Exception {
		assertThat(this.server.port()).isPositive();
		create("Private/Diary.md", "# Diary\nMy secret diary entry.\n");
		create("Private/Plans.md", "Secret plans ![[secret.png]]\n");
		this.api.putBytes("/api/files/raw?path=" + Api.enc("attachments/photo.png"), PNG).ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("attachments/secret.png"), SECRET_PNG).ok(201);
		create("Blog/Hello World.md", """
				---
				private-property: do not publish
				---
				# Welcome

				Hello from [[Diary]] and [[Private/Plans|my plans]]. %% private remark %%

				![[photo.png]]
				![[Plans]]
				<script>alert(1)</script>
				""");

		JsonNode published = this.api.postJson("/api/publish", Map.of("path", "Blog/Hello World.md")).ok(200);
		assertThat(published.get("slug").asString()).isEqualTo("hello-world");
		assertThat(published.get("title").asString()).isEqualTo("Hello World");
		assertThat(published.get("url").asString()).isEqualTo("https://notes.example.ts.net:8443/p/hello-world");
		assertThat(published.get("state").asString()).isEqualTo("current");

		JsonNode list = this.api.get("/api/publish").ok(200);
		assertThat(list.get("enabled").asBoolean()).isTrue();
		assertThat(list.get("baseUrl").asString()).isEqualTo("https://notes.example.ts.net:8443");
		assertThat(stateOf(list.get("notes"), "hello-world")).isEqualTo("current");
		assertThat(Files.readString(vault.resolve(".notesapp/publish.json"))).contains("\"slug\" : \"hello-world\"");

		RawHttp.Response page = pub("GET", "/p/hello-world");
		assertThat(page.status()).isEqualTo(200);
		assertThat(page.headers().get("content-type")).isEqualTo("text/html; charset=utf-8");
		assertThat(page.headers().get("content-security-policy")).startsWith("default-src 'none'")
			.doesNotContain("script-src");
		assertThat(page.headers().get("x-frame-options")).isEqualTo("DENY");
		assertThat(page.headers().get("x-content-type-options")).isEqualTo("nosniff");
		assertThat(page.body()).contains("<h1>Hello World</h1>").contains("Hello from Diary and my plans.");
		assertThat(page.body()).doesNotContain("Private").doesNotContain("secret").doesNotContain("Plans")
			.doesNotContain("private-property").doesNotContain("private remark").doesNotContain("<script");

		String photo = SnapshotStore.assetName(vault.resolve("attachments/photo.png"), "png");
		assertThat(page.body()).contains("src=\"/p/hello-world/" + photo + "\"");
		RawHttp.Response image = pub("GET", "/p/hello-world/" + photo);
		assertThat(image.status()).isEqualTo(200);
		assertThat(image.headers().get("content-type")).isEqualTo("image/png");
		assertThat(image.headers().get("content-security-policy")).endsWith("; sandbox");
		assertThat(pub("HEAD", "/p/hello-world").status()).isEqualTo(200);
		assertThat(pub("GET", "/p/-/style.css").status()).isEqualTo(200);

		// Nothing private is reachable, however the request is written.
		String secret = SnapshotStore.assetName(vault.resolve("attachments/secret.png"), "png");
		Files.writeString(site.resolve("rogue-dir-index.txt"), "not a snapshot");
		Files.createDirectories(site.resolve("rogue"));
		Files.writeString(site.resolve("rogue/index.html"), "<p>never listed</p>");
		Files.write(site.resolve("hello-world").resolve("aaaaaaaaaaaaaaaaaaaa.png"), PNG);
		List<String> unreachable = List.of("/", "/index.html", "/api/tree", "/api/status", "/api/me",
				"/api/files?path=" + Api.enc("Private/Diary.md"), "/api/files/raw?path=" + Api.enc("attachments/secret.png"),
				"/api/files/raw?path=" + Api.enc("attachments/photo.png"), "/api/publish", "/api/events",
				"/n/x", "/n/Private/Diary.md", "/settings", "/livez", "/actuator/health", "/sw.js",
				"/p", "/p/", "/p/hello-world/", "/p/HELLO-WORLD", "/p/hello-world/index.html",
				"/p/diary", "/p/private-diary", "/p/rogue", "/p/rogue-dir-index.txt",
				"/p/hello-world/" + secret, "/p/hello-world/aaaaaaaaaaaaaaaaaaaa.png",
				"/p/hello-world/" + photo.toUpperCase(), "/p/-/" + photo, "/p/-/../hello-world",
				"/p/hello-world/../../.notesapp/publish.json", "/p/hello-world/..%2F..%2F.git%2Fconfig",
				"/p/..%2f.git%2fconfig", "/p/%2e%2e/%2e%2e/.git/config", "/p/hello%2Dworld",
				"/.notesapp/publish.json", "/.git/config", "/.git/HEAD", "/attachments/secret.png",
				"/attachments/photo.png", "/Private/Diary.md", "/p/hello-world;x=1", "//p/hello-world",
				"/p/hello-world/" + photo + "/..", "/p//hello-world");
		for (String target : unreachable) {
			RawHttp.Response response = pub("GET", target);
			// 404 from the publish server; the JDK server itself refuses a malformed target with 400.
			assertThat(response.status()).as(target).isIn(400, 404);
			assertThat(response.body()).as(target).doesNotContain("Hello").doesNotContain("diary").doesNotContain("[core]");
		}
		for (String method : List.of("POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE")) {
			assertThat(pub(method, "/p/hello-world").status()).as(method).isEqualTo(404);
		}
		assertThat(pub("GET", "http://notes.example.ts.net/api/tree").status()).isEqualTo(404);
	}

	@Test
	void republishingUpdatesTheSnapshotAndUnpublishingRemovesItAtOnce() throws Exception {
		create("Notes/Recipe.md", "First version\n");
		this.api.postJson("/api/publish", Map.of("path", "Notes/Recipe.md", "slug", "bread", "title", "Bread")).ok(200);
		assertThat(pub("GET", "/p/bread").body()).contains("First version").contains("<title>Bread</title>");

		JsonNode file = this.api.get("/api/files?path=" + Api.enc("Notes/Recipe.md")).ok(200);
		this.api.putJson("/api/files?path=" + Api.enc("Notes/Recipe.md"),
				Map.of("content", "Second version\n", "baseVersion", file.get("version").asString())).ok(200);
		JsonNode changed = this.api.get("/api/publish").ok(200).get("notes");
		assertThat(stateOf(changed, "bread")).isEqualTo("changed");
		assertThat(pub("GET", "/p/bread").body()).contains("First version").doesNotContain("Second version");

		JsonNode again = this.api.postJson("/api/publish", Map.of("path", "Notes/Recipe.md", "slug", "sourdough"))
			.ok(200);
		assertThat(again.get("title").asString()).isEqualTo("Bread");
		assertThat(again.get("state").asString()).isEqualTo("current");
		assertThat(pub("GET", "/p/sourdough").body()).contains("Second version");
		assertThat(pub("GET", "/p/bread").status()).isEqualTo(404);
		assertThat(site.resolve("bread")).doesNotExist();

		// A rename keeps the address; the note follows.
		this.api.postJson("/api/move", Map.of("from", "Notes/Recipe.md", "to", "Notes/Sourdough.md")).ok(200);
		JsonNode moved = this.api.get("/api/publish").ok(200).get("notes");
		assertThat(pathOf(moved, "sourdough")).isEqualTo("Notes/Sourdough.md");

		Reply unpublished = this.api.delete("/api/publish?path=" + Api.enc("Notes/Sourdough.md"));
		assertThat(unpublished.status()).isEqualTo(204);
		assertThat(pub("GET", "/p/sourdough").status()).isEqualTo(404);
		assertThat(site.resolve("sourdough")).doesNotExist();
		assertThat(this.api.delete("/api/publish?path=" + Api.enc("Notes/Sourdough.md")).problem(404))
			.isEqualTo("not-found");
	}

	@Test
	void linksBetweenPublishedNotesWorkAndRequestsAreValidated() throws Exception {
		create("A.md", "Read [[B]] next.\n");
		create("B.md", "Back to [[A#Top|the start]].\n");
		this.api.postJson("/api/publish", Map.of("path", "B.md")).ok(200);
		this.api.postJson("/api/publish", Map.of("path", "A.md")).ok(200);
		assertThat(pub("GET", "/p/a").body()).contains("<a href=\"/p/b\">B</a>");
		// B was published before A: its snapshot keeps A as plain text until it is republished.
		assertThat(pub("GET", "/p/b").body()).contains("Back to the start.");
		this.api.postJson("/api/publish", Map.of("path", "B.md")).ok(200);
		assertThat(pub("GET", "/p/b").body()).contains("<a href=\"/p/a#top\">the start</a>");

		assertThat(this.api.postJson("/api/publish", Map.of("path", "A.md", "slug", "b")).problem(409))
			.isEqualTo("already-exists");
		assertThat(this.api.postJson("/api/publish", Map.of("path", "A.md", "slug", "Bad Slug")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/publish", Map.of("path", "A.md", "slug", "../x")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/publish", Map.of("path", ".notesapp/settings.json")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/publish", Map.of("path", ".git/config.md")).status()).isIn(403, 404);
		assertThat(this.api.postJson("/api/publish", Map.of("path", "Nope.md")).problem(404)).isEqualTo("not-found");
		// Encrypted notes (ROADMAP item 27, .mdenc) are never published.
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Vault/Secret.mdenc"), utf8("{\"version\":\"2.0\"}")).ok(201);
		assertThat(this.api.postJson("/api/publish", Map.of("path", "Vault/Secret.mdenc")).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/publish", Map.of("path", "A.md"), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
	}

	@Test
	void theAppRefusesEveryRequestThatCameThroughFunnel() throws Exception {
		for (String path : List.of("/api/tree", "/api/publish", "/", "/n/x", "/livez", "/actuator/health")) {
			Reply reply = this.api.get(path, "Tailscale-Funnel-Request", "?1");
			assertThat(reply.problem(403)).as(path).isEqualTo("funnel-request");
		}
		RawHttp.Response raw = RawHttp.exchange(this.port,
				"GET /api/tree HTTP/1.1\nHost: localhost\ntailscale-funnel-request: ?1\nConnection: close");
		assertThat(raw.status()).isEqualTo(403);
		assertThat(this.api.get("/api/tree").status()).isEqualTo(200);
	}

	private static String stateOf(JsonNode notes, String slug) {
		for (JsonNode note : notes) {
			if (note.get("slug").asString().equals(slug)) {
				return note.get("state").asString();
			}
		}
		throw new AssertionError("no " + slug);
	}

	private static String pathOf(JsonNode notes, String slug) {
		for (JsonNode note : notes) {
			if (note.get("slug").asString().equals(slug)) {
				return note.get("path").asString();
			}
		}
		throw new AssertionError("no " + slug);
	}

	static byte[] utf8(String s) {
		return s.getBytes(StandardCharsets.UTF_8);
	}

}
