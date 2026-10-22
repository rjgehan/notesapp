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

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Items 40 and 17 over HTTP: the metadata of many notes at once, for scripts (API.md §40.1). */
@NotesIntegrationTest
class NotesQueryIntegrationTest {

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

	private static List<String> paths(JsonNode answer) {
		List<String> out = new ArrayList<>();
		answer.get("notes").forEach((n) -> out.add(n.get("path").asString()));
		return out;
	}

	@Test
	void filtersByTagFolderPropertyLinksAndSearch() {
		create("Projects/Alpha.md", "---\nstatus: active\ntags: [project]\nowner: \"[[Ann]]\"\n---\n# Alpha\n\nSee [[Beta]].\n"
				+ "- [ ] write spec\n- [x] kickoff\n```\n- [ ] not a task\n```\n");
		create("Projects/Beta.md", "---\nstatus: done\n---\n#project/sub launch notes with zebra\n");
		create("Projects/Gamma.sheet", "{}");
		create("Daily/2026-10-21.md", "Worked on [[Alpha]] #project\n");
		create("Ann.md", "Person\n");

		JsonNode all = this.api.get("/api/notes/query?tag=project").ok(200);
		assertThat(paths(all)).containsExactly("Daily/2026-10-21.md", "Projects/Alpha.md", "Projects/Beta.md");
		assertThat(all.get("total").asInt()).isEqualTo(3);
		assertThat(all.get("truncated").asBoolean()).isFalse();
		JsonNode alpha = all.get("notes").get(1);
		assertThat(alpha.get("title").asString()).isEqualTo("Alpha");
		assertThat(alpha.get("frontmatter").get("status").asString()).isEqualTo("active");
		assertThat(alpha.get("tags").get(0).asString()).isEqualTo("project");
		assertThat(alpha.get("links").get(0).asString()).isEqualTo("Ann.md");
		assertThat(alpha.get("mtime").asString()).isNotEmpty();
		assertThat(alpha.get("tasks").isNull()).isTrue();

		assertThat(paths(this.api.get("/api/notes/query?folder=Projects&prop=" + Api.enc("status!=done")).ok(200)))
			.containsExactly("Projects/Alpha.md");
		assertThat(paths(this.api.get("/api/notes/query?prop=status").ok(200))).containsExactly("Projects/Alpha.md",
				"Projects/Beta.md");
		assertThat(paths(this.api.get("/api/notes/query?prop=" + Api.enc("owner=Ann")).ok(200)))
			.containsExactly("Projects/Alpha.md");
		assertThat(paths(this.api.get("/api/notes/query?linksTo=Alpha").ok(200))).containsExactly("Daily/2026-10-21.md");
		assertThat(paths(this.api.get("/api/notes/query?q=zebra").ok(200))).containsExactly("Projects/Beta.md");
		assertThat(paths(this.api.get("/api/notes/query?tag=project&tag=project/sub").ok(200)))
			.containsExactly("Projects/Beta.md");

		JsonNode withTasks = this.api.get("/api/notes/query?folder=Projects/&tasks=true&limit=1").ok(200);
		assertThat(paths(withTasks)).containsExactly("Projects/Alpha.md");
		assertThat(withTasks.get("total").asInt()).isEqualTo(2);
		assertThat(withTasks.get("truncated").asBoolean()).isTrue();
		JsonNode tasks = withTasks.get("notes").get(0).get("tasks");
		assertThat(tasks.size()).isEqualTo(2);
		assertThat(tasks.get(0).get("text").asString()).isEqualTo("write spec");
		assertThat(tasks.get(0).get("done").asBoolean()).isFalse();
		assertThat(tasks.get(1).get("done").asBoolean()).isTrue();
		assertThat(tasks.get(1).get("line").asInt()).isEqualTo(9);
	}

	@Test
	void refusesBadFilters() {
		assertThat(this.api.get("/api/notes/query?limit=0").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/query?limit=2001").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/query?prop=" + Api.enc("=x")).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/query?tag=" + Api.enc("#")).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/query?folder=" + "x".repeat(201)).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/query?q=" + Api.enc("/(/")).problem(400)).isEqualTo("bad-request");
	}

}
