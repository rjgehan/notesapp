package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.RawHttp;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.io.ClassPathResource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The CSRF guard, the Host allowlist and the response headers (DESIGN §8.1 integration item 3 with
 * {@code allow-default=true}), and the single-page app routes (item 10). The test classpath carries a stand-in
 * {@code static/index.html} and {@code static/assets/app-test.js}.
 */
@NotesIntegrationTest
class SecurityIntegrationTest {

	private static final String APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
			+ "img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; "
			+ "connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
			+ "form-action 'self'; frame-ancestors 'none'; manifest-src 'self'";

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

	// ---------------------------------------------------------------- item 3: the API guard

	@Test
	void mutatingRequestsNeedAWellFormedClientId() {
		Reply missing = this.api.postJson("/api/files", Map.of("path", "x.md"), "X-Client-Id", null);
		assertThat(missing.problem(403)).isEqualTo("client-id-required");
		assertThat(missing.json().get("title").asString()).isEqualTo("Client id required");
		for (String malformed : List.of("short", "has space id", "under_score_id", "x".repeat(65))) {
			assertThat(this.api.postJson("/api/files", Map.of("path", "x.md"), "X-Client-Id", malformed).problem(403))
				.as(malformed)
				.isEqualTo("client-id-required");
		}
		assertThat(this.api.delete("/api/trash", "X-Client-Id", null).problem(403)).isEqualTo("client-id-required");
		assertThat(this.api.putJson("/api/settings", Map.of(), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		assertThat(this.api.postJson("/api/links/resolve", Map.of("source", "a.md", "targets", List.of("x")),
				"X-Client-Id", null)
			.problem(403)).isEqualTo("client-id-required");
		assertThat(this.api.postBytes("/api/attachments?name=a.png", new byte[] { 1 }, "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		assertThat(this.api.postJson("/api/files", Map.of("path", "Guard/ok.md"), "X-Client-Id", "a-valid-client-id")
			.status()).isEqualTo(201);
	}

	@Test
	void getsNeedNoCustomHeaders() {
		assertThat(this.api.get("/api/tree", "X-Client-Id", null).status()).isEqualTo(200);
		assertThat(this.api.get("/api/settings", "X-Client-Id", null).status()).isEqualTo(200);
		assertThat(this.api.get("/api/search?q=x", "X-Client-Id", null, "Origin", "https://evil.example").status())
			.isEqualTo(200);
	}

	@Test
	void crossOriginMutationsAreRejected() {
		String self = "http://localhost:" + this.port;
		for (String origin : List.of("https://evil.example", "null", "http://localhost:1", "http://localhost",
				"not a url")) {
			Reply reply = this.api.postJson("/api/files", Map.of("path", "x.md"), "Origin", origin);
			assertThat(reply.problem(403)).as(origin).isEqualTo("cross-origin");
			assertThat(reply.json().get("title").asString()).isEqualTo("Cross-origin request rejected");
		}
		assertThat(this.api.postJson("/api/files", Map.of("path", "x.md"), "Sec-Fetch-Site", "cross-site").problem(403))
			.isEqualTo("cross-origin");
		assertThat(this.api.postJson("/api/files", Map.of("path", "x.md"), "Sec-Fetch-Site", "same-site").problem(403))
			.isEqualTo("cross-origin");
		assertThat(this.api.postJson("/api/files", Map.of("path", "Guard/same.md"), "Origin", self.toUpperCase(),
				"Sec-Fetch-Site", "same-origin")
			.status()).isEqualTo(201);
		assertThat(this.api.postJson("/api/files", Map.of("path", "Guard/none.md"), "Sec-Fetch-Site", "none").status())
			.isEqualTo(201);
	}

	@Test
	void unknownHostsGet421AndHealthPathsAreExempt() throws IOException {
		RawHttp.Response evil = RawHttp.exchange(this.port, """
				GET /api/tree HTTP/1.1
				Host: evil.example:%d
				Connection: close
				""".formatted(this.port));
		assertThat(evil.status()).isEqualTo(421);
		assertThat(evil.headers().get("content-type")).startsWith("application/problem+json");
		JsonNode problem = Api.JSON.readTree(evil.body());
		assertThat(problem.get("code").asString()).isEqualTo("unknown-host");
		assertThat(problem.get("title").asString()).isEqualTo("Unknown host");
		assertThat(problem.get("instance").asString()).isEqualTo("/api/tree");

		assertThat(RawHttp.exchange(this.port, "GET /n/x HTTP/1.1\nHost: evil.example\nConnection: close").status())
			.isEqualTo(421);
		assertThat(RawHttp.exchange(this.port, "GET /api/tree HTTP/1.1\nConnection: close").status()).isEqualTo(400);
		for (String health : List.of("/readyz", "/livez", "/actuator/health")) {
			RawHttp.Response response = RawHttp.exchange(this.port,
					"GET " + health + " HTTP/1.1\nHost: evil.example\nConnection: close");
			assertThat(response.status()).as(health).isEqualTo(200);
			assertThat(Api.JSON.readTree(response.body()).get("status").asString()).isEqualTo("UP");
		}
	}

	// ---------------------------------------------------------------- headers

	@Test
	void apiResponsesCarryTheSecurityHeaders() {
		Reply tree = this.api.get("/api/tree");
		assertThat(tree.status()).isEqualTo(200);
		assertThat(tree.json().get("eventId").asString()).matches("[0-9a-z]+\\.\\d+");
		assertThat(tree.header("Cache-Control")).isEqualTo("no-store");
		assertThat(tree.header("X-Notes-Build")).isEqualTo("dev");
		assertThat(tree.header("Content-Security-Policy")).isEqualTo(APP_CSP);
		assertThat(tree.header("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(tree.header("Referrer-Policy")).isEqualTo("no-referrer");
		assertThat(tree.header("X-Frame-Options")).isEqualTo("DENY");
		assertThat(tree.header("Cross-Origin-Opener-Policy")).isEqualTo("same-origin");
		assertThat(tree.header("Cross-Origin-Resource-Policy")).isEqualTo("same-origin");
		assertThat(tree.header("Permissions-Policy")).isEqualTo("camera=(), microphone=(), geolocation=(), payment=()");
		assertThat(tree.headers().get("Cache-Control")).hasSize(1);

		Reply problem = this.api.get("/api/files?path=nope.md");
		assertThat(problem.problem(404)).isEqualTo("not-found");
		assertThat(problem.header("Cache-Control")).isEqualTo("no-store");
		assertThat(problem.header("X-Notes-Build")).isEqualTo("dev");
	}

	@Test
	void pathParametersAndEscapesDoNotSkipTheApiFilters() throws IOException {
		for (String tree : List.of("/api;x=1/tree", "/%61pi/tree", "/api/tree;x=1")) {
			RawHttp.Response response = RawHttp.exchange(this.port,
					"GET " + tree + " HTTP/1.1\nHost: localhost:" + this.port + "\nConnection: close");
			assertThat(response.status()).as(tree).isEqualTo(200);
			assertThat(response.headers().get("cache-control")).as(tree).isEqualTo("no-store");
		}
		for (String files : List.of("/api/files", "/api;jsessionid=x/files", "/%61pi/files")) {
			// The announced length alone is over the JSON body limit; the body is never sent.
			RawHttp.Response response = RawHttp.exchange(this.port, """
					POST %s HTTP/1.1
					Host: localhost:%d
					X-Client-Id: %s
					Content-Type: application/json
					Content-Length: %d
					Connection: close
					""".formatted(files, this.port, Api.CLIENT_ID, 17L * 1024 * 1024));
			assertThat(response.status()).as(files).isEqualTo(413);
			assertThat(Api.JSON.readTree(response.body()).get("code").asString()).isEqualTo("too-large");
		}
		RawHttp.Response sneaky = RawHttp.exchange(this.port,
				"GET /actuator/health/..;/..;/api/tree HTTP/1.1\nHost: evil.example\nConnection: close");
		assertThat(sneaky.status()).isEqualTo(421);
	}

	@Test
	void theTreeListsVisibleEntriesSorted() {
		this.api.postJson("/api/files", Map.of("path", "Tree/b.md", "content", "---\naliases: [Bee]\n---\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Tree/a.md")).ok(201);
		this.api.postJson("/api/folders", Map.of("path", "Tree/Empty")).ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Tree/archive.tar.gz"), new byte[] { 1 }).ok(201);
		JsonNode tree = this.api.get("/api/tree").ok(200);
		List<String> files = tree.get("files").values().stream().map((f) -> f.get("path").asString()).toList();
		assertThat(files).containsSubsequence("Tree/a.md", "Tree/archive.tar.gz", "Tree/b.md");
		assertThat(files).noneMatch((path) -> path.startsWith("."));
		List<String> folders = tree.get("folders").values().stream().map((f) -> f.get("path").asString()).toList();
		assertThat(folders).contains("Tree", "Tree/Empty").noneMatch((path) -> path.startsWith("."));
		JsonNode archive = tree.get("files")
			.values()
			.stream()
			.filter((f) -> f.get("path").asString().equals("Tree/archive.tar.gz"))
			.findFirst()
			.orElseThrow();
		assertThat(archive.get("basename").asString()).isEqualTo("archive.tar");
		assertThat(archive.get("extension").asString()).isEqualTo("gz");
		assertThat(archive.get("kind").asString()).isEqualTo("other");
		assertThat(archive.get("version").isNull()).isTrue();
		assertThat(archive.get("aliases").isEmpty()).isTrue();
		JsonNode note = tree.get("files")
			.values()
			.stream()
			.filter((f) -> f.get("path").asString().equals("Tree/b.md"))
			.findFirst()
			.orElseThrow();
		assertThat(note.get("aliases").get(0).asString()).isEqualTo("Bee");
		assertThat(note.size()).isEqualTo(9);
	}

	// ---------------------------------------------------------------- item 10: the single-page app

	@ParameterizedTest
	@ValueSource(strings = { "/n/Some%20Note.md", "/n/Projects/Plan.md", "/", "/search", "/trash", "/settings",
			"/settings/this-device", "/x/kanban/board" })
	void clientRoutesServeTheAppShell(String route) throws IOException {
		Reply page = this.api.get(route);
		assertThat(page.status()).isEqualTo(200);
		assertThat(page.header("Content-Type")).startsWith("text/html");
		assertThat(page.text())
			.isEqualTo(new ClassPathResource("static/index.html").getContentAsString(StandardCharsets.UTF_8));
		assertThat(page.header("Cache-Control")).isEqualTo("no-cache");
		assertThat(page.header("Content-Security-Policy")).isEqualTo(APP_CSP);
		assertThat(page.header("X-Frame-Options")).isEqualTo("DENY");
		assertThat(page.header("X-Notes-Build")).isEqualTo("dev");
	}

	@Test
	void bundlesAreImmutableAndRootFilesRevalidate() {
		Reply bundle = this.api.get("/assets/app-test.js");
		assertThat(bundle.status()).isEqualTo(200);
		assertThat(bundle.text()).contains("test bundle");
		assertThat(bundle.header("Cache-Control")).isEqualTo("max-age=31536000, public, immutable");
		Reply root = this.api.get("/theme-boot.js");
		assertThat(root.status()).isEqualTo(200);
		assertThat(root.header("Cache-Control")).isEqualTo("no-cache");
		assertThat(this.api.get("/assets/missing.js").problem(404)).isEqualTo("not-found");
	}

	@Test
	void unknownRoutesAreProblemJson() {
		Reply api = this.api.get("/api/nope");
		assertThat(api.problem(404)).isEqualTo("not-found");
		assertThat(api.header("Cache-Control")).isEqualTo("no-store");
		assertThat(this.api.get("/nope").problem(404)).isEqualTo("not-found");
		assertThat(this.api.delete("/api/tree").problem(405)).isEqualTo("method-not-allowed");
	}

}
