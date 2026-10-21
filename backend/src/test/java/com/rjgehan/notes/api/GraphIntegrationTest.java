package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** {@code GET /api/graph} (API.md §11.4, ROADMAP item 16) over HTTP: nodes, edges, {@code since} and exclusions. */
@NotesIntegrationTest
class GraphIntegrationTest {

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

	private JsonNode save(String path, String content) {
		JsonNode current = this.api.get("/api/files?path=" + Api.enc(path)).ok(200);
		return this.api
			.putJson("/api/files?path=" + Api.enc(path),
					Map.of("content", content, "baseVersion", current.get("version").asString()))
			.ok(200);
	}

	private static List<String> edges(JsonNode graph) {
		List<String> edges = new ArrayList<>();
		JsonNode nodes = graph.get("nodes");
		JsonNode e = graph.get("edges");
		for (int i = 0; i < e.size(); i += 3) {
			edges.add(nodes.get(e.get(i).asInt()).get("path").asString() + " -> "
					+ nodes.get(e.get(i + 1).asInt()).get("path").asString() + " x" + e.get(i + 2).asInt());
		}
		return edges;
	}

	private static List<String> paths(JsonNode graph) {
		List<String> paths = new ArrayList<>();
		graph.get("nodes").forEach((node) -> paths.add(node.get("type").asString() + ":" + node.get("path").asString()));
		return paths;
	}

	@Test
	void theGraphListsFilesUnresolvedTargetsAndLinksAndAnswersUnchangedForTheSameVersion() {
		this.api.postJson("/api/files", Map.of("path", "Graph/Hub.md", "content", "[[Spoke]] [[Spoke]] [[Todo]] #hub\n"))
			.ok(201);
		this.api.postJson("/api/files", Map.of("path", "Graph/Spoke.md", "content", "Back to [[Hub]] ![[pic.png]]\n"))
			.ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Graph/pic.png"), new byte[] { 1, 2, 3 }).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Archive/Old.md", "content", "[[Hub]]\n")).ok(201);

		JsonNode graph = this.api.get("/api/graph").ok(200);
		assertThat(graph.get("unchanged").asBoolean()).isFalse();
		assertThat(paths(graph)).contains("note:Graph/Hub.md", "note:Graph/Spoke.md", "attachment:Graph/pic.png",
				"note:Archive/Old.md", "unresolved:Todo");
		assertThat(edges(graph)).contains("Graph/Hub.md -> Graph/Spoke.md x2", "Graph/Hub.md -> Todo x1",
				"Graph/Spoke.md -> Graph/Hub.md x1", "Graph/Spoke.md -> Graph/pic.png x1", "Archive/Old.md -> Graph/Hub.md x1");
		JsonNode hub = graph.get("nodes").values().stream()
			.filter((node) -> node.get("path").asString().equals("Graph/Hub.md"))
			.findFirst()
			.orElseThrow();
		assertThat(hub.get("tags").get(0).asString()).isEqualTo("hub");

		String version = graph.get("version").asString();
		JsonNode same = this.api.get("/api/graph?since=" + Api.enc(version)).ok(200);
		assertThat(same.get("unchanged").asBoolean()).isTrue();
		assertThat(same.get("version").asString()).isEqualTo(version);
		assertThat(same.get("nodes").isEmpty()).isTrue();
		assertThat(same.get("edges").isEmpty()).isTrue();

		// An edit that keeps the links keeps the version; a new link changes it.
		save("Graph/Spoke.md", "Back to [[Hub]] ![[pic.png]], with more words\n");
		assertThat(this.api.get("/api/graph?since=" + Api.enc(version)).ok(200).get("unchanged").asBoolean()).isTrue();
		save("Graph/Spoke.md", "Back to [[Hub]] ![[pic.png]] and [[Todo]]\n");
		JsonNode changed = this.api.get("/api/graph?since=" + Api.enc(version)).ok(200);
		assertThat(changed.get("unchanged").asBoolean()).isFalse();
		assertThat(edges(changed)).contains("Graph/Spoke.md -> Todo x1");

		// Excluded paths leave the graph, as in Obsidian.
		JsonNode current = this.api.get("/api/settings").ok(200);
		ObjectNode settings = (ObjectNode) current.get("settings").deepCopy();
		((ArrayNode) settings.get("files").get("excludedPaths")).add("Archive");
		this.api.putJson("/api/settings", Map.of("settings", settings, "baseVersion", current.get("version").asString()))
			.ok(200);
		JsonNode excluded = this.api.get("/api/graph?since=" + Api.enc(changed.get("version").asString())).ok(200);
		assertThat(excluded.get("unchanged").asBoolean()).isFalse();
		assertThat(paths(excluded)).doesNotContain("note:Archive/Old.md");
		assertThat(edges(excluded)).noneMatch((edge) -> edge.startsWith("Archive/"));
	}

}
