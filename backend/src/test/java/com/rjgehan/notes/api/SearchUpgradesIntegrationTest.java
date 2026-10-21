package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.TestPdfs;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Item 22 over HTTP: OR and groups, regular expressions, scopes, PDF text and saved searches (API.md §12). */
@NotesIntegrationTest
class SearchUpgradesIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
	}

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

	private void create(String path, String content) {
		this.api.postJson("/api/files", Map.of("path", path, "content", content)).ok(201);
	}

	private JsonNode search(String query) {
		return this.api.get("/api/search?q=" + Api.enc(query)).ok(200);
	}

	private static List<String> paths(JsonNode response) {
		List<String> paths = new ArrayList<>();
		response.get("results").forEach((hit) -> paths.add(hit.get("path").asString()));
		return paths;
	}

	@Test
	void theRicherQueryLanguage() {
		create("Lang/Cats.md", "I like cats\nand dogs too\n");
		create("Lang/Dogs.md", "I like dogs and cats\n");
		create("Lang/Recipe.md", "# Cake\nmix flour and sugar\n# Notes\nmix later\n");
		assertThat(paths(search("path:lang (cats OR flour) -recipe"))).containsExactlyInAnyOrder("Lang/Cats.md",
				"Lang/Dogs.md");
		assertThat(paths(search("path:lang line:(dogs cats)"))).containsExactly("Lang/Dogs.md");
		assertThat(paths(search("section:(cake flour)"))).containsExactly("Lang/Recipe.md");
		assertThat(paths(search("section:(cake later)"))).isEmpty();
		JsonNode regex = search("/l[io]ke? (cats|dogs)/ path:lang");
		assertThat(paths(regex)).containsExactlyInAnyOrder("Lang/Cats.md", "Lang/Dogs.md");
		JsonNode match = regex.get("results").get(0).get("matches").get(0);
		assertThat(match.get("ranges").get(0).get("from").asInt()).isEqualTo(2);
		assertThat(match.get("page").isNull()).isTrue();
	}

	@Test
	void invalidAndRunawayRegularExpressionsAreBadRequests() {
		create("Regex/Numbers.md", "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28\n");
		Api.Reply invalid = this.api.get("/api/search?q=" + Api.enc("/a(b/"));
		assertThat(invalid.problem(400)).isEqualTo("bad-request");
		assertThat(invalid.json().get("errors").get(0).get("field").asString()).isEqualTo("q");
		assertThat(invalid.json().get("detail").asString()).contains("Invalid regular expression");
		Api.Reply runaway = this.api.get("/api/search?q=" + Api.enc("/(.*?,){30}P/"));
		assertThat(runaway.problem(400)).isEqualTo("bad-request");
		assertThat(runaway.json().get("detail").asString()).contains("took too long");
		assertThat(this.api.get("/api/search?q=" + Api.enc("x".repeat(2001))).problem(400)).isEqualTo("bad-request");
	}

	@Test
	void pdfTextIsSearchableWithItsPage() {
		byte[] pdf = TestPdfs.withPages("Getting started\nInstall the plotter", "Troubleshooting\nPaper jam in tray two");
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Docs/Plotter manual.pdf"), pdf).ok(201);
		await().atMost(Duration.ofSeconds(30)).until(() -> search("paper jam").get("total").asInt() == 1);
		JsonNode hit = search("paper jam").get("results").get(0);
		assertThat(hit.get("path").asString()).isEqualTo("Docs/Plotter manual.pdf");
		assertThat(hit.get("kind").asString()).isEqualTo("pdf");
		assertThat(hit.get("basename").asString()).isEqualTo("Plotter manual");
		JsonNode match = hit.get("matches").get(0);
		assertThat(match.get("page").asInt()).isEqualTo(2);
		assertThat(match.get("text").asString()).isEqualTo("Paper jam in tray two");
		assertThat(paths(search("file:plotter"))).containsExactly("Docs/Plotter manual.pdf");
		assertThat(Files.isDirectory(vault.resolve(".notesapp/cache/search-text"))).isTrue();
		// The text is not part of the note count.
		assertThat(this.api.get("/api/status").ok(200).get("vault").get("notes").asInt()).isEqualTo(
				this.api.get("/api/tree").ok(200).get("files").valueStream().filter((f) -> f.get("kind").asString()
					.equals("note")).count());
	}

	@Test
	void savedSearchesSyncThroughTheVault() throws Exception {
		JsonNode empty = this.api.get("/api/searches").ok(200);
		assertThat(empty.get("searches").isEmpty()).isTrue();
		assertThat(empty.get("version").isNull()).isTrue();

		Map<String, Object> open = Map.of("id", "s-open", "name", "Open loops", "query", "tag:#todo -done", "sort",
				"relevance");
		JsonNode created = this.api.putJson("/api/searches",
				Map.of("searches", List.of(open), "baseVersion", "")).ok(200);
		String version = created.get("version").asString();
		assertThat(version).hasSize(40);
		assertThat(created.get("searches").get(0).get("name").asString()).isEqualTo("Open loops");
		String file = Files.readString(vault.resolve(".notesapp/searches.json"), StandardCharsets.UTF_8);
		assertThat(file).contains("\"schemaVersion\" : 1").contains("tag:#todo -done");

		JsonNode listed = this.api.get("/api/searches").ok(200);
		assertThat(listed.get("version").asString()).isEqualTo(version);
		assertThat(listed.get("searches").get(0).get("query").asString()).isEqualTo("tag:#todo -done");

		Map<String, Object> recent = Map.of("id", "s-recent", "name", "Recent", "query", "path:Daily", "sort",
				"mtime");
		Api.Reply stale = this.api.putJson("/api/searches",
				Map.of("searches", List.of(recent), "baseVersion", "0".repeat(40)));
		assertThat(stale.problem(409)).isEqualTo("version-conflict");
		assertThat(stale.json().get("currentVersion").asString()).isEqualTo(version);

		JsonNode updated = this.api.putJson("/api/searches",
				Map.of("searches", List.of(open, recent), "baseVersion", version)).ok(200);
		assertThat(updated.get("searches").size()).isEqualTo(2);
		// Saving the same list again is not a conflict, whatever the base.
		this.api.putJson("/api/searches",
				Map.of("searches", List.of(open, recent), "baseVersion", version)).ok(200);

		Api.Reply invalid = this.api.putJson("/api/searches", Map.of("searches",
				List.of(Map.of("id", "bad id!", "name", "", "query", "x", "sort", "size")), "baseVersion",
				updated.get("version").asString()));
		assertThat(invalid.problem(400)).isEqualTo("bad-request");
		assertThat(invalid.json().get("errors").valueStream().map((e) -> e.get("field").asString()))
			.contains("searches[0].id", "searches[0].name", "searches[0].sort");
		assertThat(this.api.putJson("/api/searches", Map.of("searches", List.of(open), "baseVersion", ""),
				"X-Client-Id", null).problem(403)).isEqualTo("client-id-required");
	}

}
