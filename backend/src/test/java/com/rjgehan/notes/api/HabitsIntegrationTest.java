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

/** Item 35 over HTTP: habit notes and the daily-note values that check habits in (API.md §35). */
@NotesIntegrationTest
class HabitsIntegrationTest {

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

	@Test
	void habitNotesAndDailyValuesComeInOneAnswer() {
		create("Habits/Exercise.md", "---\ntitle: Morning workout\ncolor: \"#4CAF50\"\nschedule: mon, wed, fri\nentries:\n  - 2026-10-19\n  - 2026-10-21\n---\nWhy I do it.\n");
		create("Life/Read.md", "---\ntags: [habit]\nentries: []\n---\n");
		create("Life/Floss.md", "Daily. #habit/health\n");
		create("Templates/Habit.md", "---\ntags: [habit]\nentries: []\n---\n");
		create("Daily/2026-10-20.md", "---\nexercise: true\nmood: 4\nsummary: short\ntags: [daily]\nlong: \"" + "x".repeat(150) + "\"\n---\nRan.\n");
		create("Daily/2026-10-21.md", "No frontmatter.\n");
		create("Elsewhere.md", "---\nexercise: true\n---\n");

		JsonNode habits = this.api.get("/api/habits").ok(200);
		assertThat(habits.get("folder").asString()).isEqualTo("Habits");
		assertThat(habits.get("tag").asString()).isEqualTo("habit");
		assertThat(habits.get("dailyFolder").asString()).isEqualTo("Daily");
		List<String> paths = new ArrayList<>();
		habits.get("habits").forEach((h) -> paths.add(h.get("path").asString()));
		assertThat(paths).containsExactly("Habits/Exercise.md", "Life/Floss.md", "Life/Read.md");
		JsonNode exercise = habits.get("habits").get(0);
		assertThat(exercise.get("version").asString()).matches("[0-9a-f]{40}");
		assertThat(exercise.get("properties").get("title").asString()).isEqualTo("Morning workout");
		assertThat(exercise.get("properties").get("entries").get(1).asString()).isEqualTo("2026-10-21");
		assertThat(habits.get("habits").get(1).get("properties").size()).isZero();

		JsonNode daily = habits.get("daily");
		assertThat(daily.size()).isEqualTo(1);
		assertThat(daily.get(0).get("path").asString()).isEqualTo("Daily/2026-10-20.md");
		JsonNode values = daily.get(0).get("values");
		assertThat(values.get("exercise").asBoolean()).isTrue();
		assertThat(values.get("mood").asInt()).isEqualTo(4);
		assertThat(values.get("summary").asString()).isEqualTo("short");
		assertThat(values.has("tags")).isFalse();
		assertThat(values.has("long")).isFalse();
	}

}
