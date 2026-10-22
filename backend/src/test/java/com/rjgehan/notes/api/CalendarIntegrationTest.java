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

/** Item 14 over HTTP: the notes a frontmatter property dates, for the calendar (API.md §25). */
@NotesIntegrationTest
class CalendarIntegrationTest {

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

	private static List<String> rows(JsonNode answer) {
		List<String> rows = new ArrayList<>();
		answer.get("notes")
			.forEach((n) -> rows.add(n.get("day").asString() + " " + n.get("path").asString() + " "
					+ n.get("property").asString() + "=" + n.get("value").asString()));
		return rows;
	}

	@Test
	void notesDatedByAPropertyInTheRange() {
		create("Meetings/Kickoff.md", "---\ndate: 2026-11-03\n---\nAgenda.\n");
		create("Meetings/Review.md", "---\nDate: 2026-11-10T14:30\n---\n");
		create("Trips/Lisbon.md", "---\ndate:\n  - 2026-11-20\n  - \"[[2026-11-21]]\"\n  - 2026-11-20\n---\n");
		create("Outside.md", "---\ndate: 2026-12-01\n---\n");
		create("NotADate.md", "---\ndate: next week\n---\n");
		create("Invalid.md", "---\ndate: 2026-02-30\n---\n");
		create("NoFrontmatter.md", "date: 2026-11-04\n");
		create("Templates/Meeting.md", "---\ndate: 2026-11-05\n---\n");
		create("Projects/Launch.md", "---\ndeadline: 2026-11-15\ndate: 2026-11-01\n---\n");

		JsonNode answer = this.api.get("/api/notes/by-date?from=2026-11-01&to=2026-11-30").ok(200);
		assertThat(answer.get("from").asString()).isEqualTo("2026-11-01");
		assertThat(answer.get("to").asString()).isEqualTo("2026-11-30");
		assertThat(answer.get("properties").get(0).asString()).isEqualTo("date");
		assertThat(rows(answer)).containsExactly("2026-11-01 Projects/Launch.md date=2026-11-01",
				"2026-11-03 Meetings/Kickoff.md date=2026-11-03", "2026-11-10 Meetings/Review.md Date=2026-11-10T14:30",
				"2026-11-20 Trips/Lisbon.md date=2026-11-20", "2026-11-21 Trips/Lisbon.md date=[[2026-11-21]]");

		JsonNode deadlines = this.api.get("/api/notes/by-date?from=2026-11-01&to=2026-11-30&property=deadline,%20date")
			.ok(200);
		assertThat(deadlines.get("properties").size()).isEqualTo(2);
		assertThat(rows(deadlines)).contains("2026-11-15 Projects/Launch.md deadline=2026-11-15",
				"2026-11-01 Projects/Launch.md date=2026-11-01");
	}

	@Test
	void editsShowAtOnce() {
		create("Later.md", "---\ndate: 2027-01-05\n---\n");
		assertThat(rows(this.api.get("/api/notes/by-date?from=2027-01-01&to=2027-01-31").ok(200)))
			.containsExactly("2027-01-05 Later.md date=2027-01-05");
		JsonNode file = this.api.get("/api/files?path=Later.md").ok(200);
		this.api
			.putJson("/api/files?path=Later.md",
					Map.of("content", "---\ndate: 2027-01-06\n---\n", "baseVersion", file.get("version").asString()))
			.ok(200);
		assertThat(rows(this.api.get("/api/notes/by-date?from=2027-01-01&to=2027-01-31").ok(200)))
			.containsExactly("2027-01-06 Later.md date=2027-01-06");
	}

	@Test
	void badRangesAndPropertiesAreRejected() {
		assertThat(this.api.get("/api/notes/by-date?to=2026-11-30").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/by-date?from=2026-11-31&to=2026-12-01").problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/by-date?from=2026-11-02&to=2026-11-01").problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/by-date?from=2026-01-01&to=2027-01-02").problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.get("/api/notes/by-date?from=2026-01-01&to=2026-12-31&property=a,b,c,d,e,f").problem(400))
			.isEqualTo("bad-request");
		this.api.get("/api/notes/by-date?from=2026-01-01&to=2027-01-01").ok(200);
	}

}
