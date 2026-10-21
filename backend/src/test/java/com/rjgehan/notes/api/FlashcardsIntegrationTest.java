package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.SseRecorder;
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

/** Item 34 over HTTP: review records in {@code .notesapp/srs.json}, settings and source notes (API.md §34). */
@NotesIntegrationTest
class FlashcardsIntegrationTest {

	private static final String PHONE = "phone-client-0001";

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

	@LocalServerPort
	int port;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private static Map<String, Object> review(String card, String at, String rating) {
		Map<String, Object> review = new LinkedHashMap<>();
		review.put("card", card);
		review.put("at", at);
		review.put("rating", rating);
		return review;
	}

	private static Map<String, Object> state(String due, int n, String lastReview) {
		Map<String, Object> state = new LinkedHashMap<>();
		state.put("due", due);
		state.put("stability", 2.3065);
		state.put("difficulty", 2.1181);
		state.put("scheduledDays", 2);
		state.put("learningSteps", 0);
		state.put("reps", n);
		state.put("lapses", 0);
		state.put("phase", "review");
		state.put("lastReview", lastReview);
		state.put("n", n);
		return state;
	}

	private JsonNode reviews(String clientId, List<Map<String, Object>> reviews) {
		return this.api.postJson("/api/flashcards/reviews", Map.of("reviews", reviews), "X-Client-Id", clientId)
			.ok(200);
	}

	private static List<String> list(JsonNode array) {
		List<String> values = new ArrayList<>();
		array.forEach((item) -> values.add(item.asString()));
		return values;
	}

	@Test
	void answersFromTwoDevicesAreUnitedAndAStaleStateIsDropped() throws Exception {
		JsonNode empty = this.api.get("/api/flashcards").ok(200);
		assertThat(empty.get("config").get("tags").get(0).asString()).isEqualTo("flashcards");
		assertThat(empty.get("config").get("newPerDay").asInt()).isEqualTo(20);

		Map<String, Object> first = review("kq1", "2026-10-01T09:00:00.000Z", "good");
		first.put("note", "Biology/Cells.md");
		first.put("front", "What is   the\npowerhouse of the cell?");
		first.put("ms", 4200);
		first.put("state", state("2026-10-03T09:00:00.000Z", 1, "2026-10-01T09:00:00.000Z"));
		JsonNode written;
		try (SseRecorder others = SseRecorder.open(this.port, "observer-client-01", null);
				SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null)) {
			written = reviews(Api.CLIENT_ID, List.of(first));
			JsonNode card = written.get("cards").get("kq1");
			assertThat(card.get("front").asString()).isEqualTo("What is the powerhouse of the cell?");
			assertThat(list(card.get("reviews"))).containsExactly("2026-10-01T09:00:00.000Z good 4200");
			assertThat(card.get("state").get("n").asInt()).isEqualTo(1);
			others.awaitEvent("flashcards.changed");
			JsonNode event = others.frames()
				.stream()
				.filter((frame) -> frame.event().equals("flashcards.changed"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(event.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			assertThat(event.get("version").asString()).isEqualTo(written.get("version").asString());
			assertThat(list(event.get("cards").get("kq1").get("reviews"))).hasSize(1);
			assertThat(event.get("config").isNull()).isTrue();
			this.api.postJson("/api/files", Map.of("path", "After review.md")).ok(201);
			others.awaitEvent("file.created");
			assertThat(mine.eventNames()).doesNotContain("flashcards.changed");
		}

		// The same answer again (a retry whose response was lost) changes nothing.
		JsonNode retried = reviews(Api.CLIENT_ID, List.of(first));
		assertThat(retried.get("version").asString()).isEqualTo(written.get("version").asString());

		// Two devices answer the card from the same state: both answers count; neither state covers both.
		Map<String, Object> desktop = review("kq1", "2026-10-03T10:00:00.000Z", "good");
		desktop.put("state", state("2026-10-10T10:00:00.000Z", 2, "2026-10-03T10:00:00.000Z"));
		reviews(Api.CLIENT_ID, List.of(desktop));
		Map<String, Object> phone = review("kq1", "2026-10-03T09:30:00.000Z", "again");
		phone.put("state", state("2026-10-03T09:31:00.000Z", 2, "2026-10-03T09:30:00.000Z"));
		JsonNode merged = reviews(PHONE, List.of(phone)).get("cards").get("kq1");
		assertThat(list(merged.get("reviews"))).containsExactly("2026-10-01T09:00:00.000Z good 4200",
				"2026-10-03T09:30:00.000Z again", "2026-10-03T10:00:00.000Z good");
		assertThat(merged.get("state").isNull()).isTrue();

		// A client that recomputed from all three answers stores its state with its next answer.
		Map<String, Object> next = review("kq1", "2026-10-04T08:00:00.000Z", "hard");
		next.put("state", state("2026-10-06T08:00:00.000Z", 4, "2026-10-04T08:00:00.000Z"));
		assertThat(reviews(PHONE, List.of(next)).get("cards").get("kq1").get("state").get("n").asInt()).isEqualTo(4);

		// Undo removes the answer and restores the state before it, when that state covers the rest.
		Map<String, Object> undo = new LinkedHashMap<>();
		undo.put("card", "kq1");
		undo.put("at", "2026-10-04T08:00:00.000Z");
		undo.put("state", state("2026-10-05T10:00:00.000Z", 3, "2026-10-03T10:00:00.000Z"));
		JsonNode undone = this.api.postJson("/api/flashcards/undo", undo).ok(200).get("cards").get("kq1");
		assertThat(list(undone.get("reviews"))).hasSize(3);
		assertThat(undone.get("state").get("n").asInt()).isEqualTo(3);

		String file = Files.readString(vault.resolve(".notesapp/srs.json"), StandardCharsets.UTF_8);
		assertThat(file).contains("\"kq1\": {", "\"note\": \"Biology/Cells.md\"",
				"        \"2026-10-03T09:30:00.000Z again\",");
		JsonNode all = this.api.get("/api/flashcards").ok(200);
		assertThat(list(all.get("cards").get("kq1").get("reviews"))).hasSize(3);
		assertThat(all.get("version").asString()).matches("[0-9a-f]{40}");
	}

	@Test
	void anEditedCardTakesItsRecordAlongAndPruneForgetsRecords() {
		reviews(Api.CLIENT_ID, List.of(review("old1", "2026-10-01T07:00:00.000Z", "good"),
				review("gone1", "2026-10-01T07:01:00.000Z", "easy")));
		Map<String, Object> renamed = review("new1", "2026-10-02T09:00:00.000Z", "good");
		renamed.put("from", "old1");
		JsonNode cards = reviews(Api.CLIENT_ID, List.of(renamed)).get("cards");
		assertThat(cards.get("old1").isNull()).isTrue();
		assertThat(list(cards.get("new1").get("reviews"))).containsExactly("2026-10-01T07:00:00.000Z good",
				"2026-10-02T09:00:00.000Z good");

		JsonNode pruned = this.api.postJson("/api/flashcards/prune", Map.of("cards", List.of("gone1", "nothing")))
			.ok(200);
		assertThat(pruned.get("cards").has("gone1")).isTrue();
		assertThat(pruned.get("cards").has("nothing")).isFalse();
		JsonNode all = this.api.get("/api/flashcards").ok(200).get("cards");
		assertThat(all.has("gone1")).isFalse();
		assertThat(all.has("old1")).isFalse();
		assertThat(all.has("new1")).isTrue();

		Map<String, Object> undoLast = new LinkedHashMap<>();
		undoLast.put("card", "new1");
		undoLast.put("at", "2026-10-01T07:00:00.000Z");
		this.api.postJson("/api/flashcards/undo", undoLast).ok(200);
		undoLast.put("at", "2026-10-02T09:00:00.000Z");
		JsonNode removed = this.api.postJson("/api/flashcards/undo", undoLast).ok(200);
		assertThat(removed.get("cards").get("new1").isNull()).isTrue();
	}

	@Test
	void invalidAnswersAreRefusedWithEveryField() {
		Map<String, Object> bad = new LinkedHashMap<>();
		bad.put("card", "has space");
		bad.put("at", "yesterday");
		bad.put("rating", "meh");
		bad.put("ms", -5);
		Map<String, Object> future = review("ok1", "2099-01-01T00:00:00.000Z", "good");
		Api.Reply reply = this.api.postJson("/api/flashcards/reviews", Map.of("reviews", List.of(bad, future)));
		assertThat(reply.problem(400)).isEqualTo("bad-request");
		List<String> fields = new ArrayList<>();
		reply.json().get("errors").forEach((e) -> fields.add(e.get("field").asString()));
		assertThat(fields).contains("reviews[0].card", "reviews[0].at", "reviews[0].rating", "reviews[0].ms",
				"reviews[1].at");
		assertThat(this.api.postJson("/api/flashcards/reviews", Map.of("reviews", List.of())).problem(400))
			.isEqualTo("bad-request");
		Map<String, Object> anonymous = Map.of("reviews", List.of(review("x", "2026-10-01T09:00:00Z", "good")));
		assertThat(this.api.postJson("/api/flashcards/reviews", anonymous, "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
	}

	@Test
	void settingsChangeFieldByFieldAndChooseTheSourceNotes() throws Exception {
		this.api.postJson("/api/files", Map.of("path", "Cards/Bio.md", "content", "#flashcards/bio\nQ1::A1\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Cards/Geo.md", "content", "---\ntags: [srs]\n---\nQ2::A2\n"))
			.ok(201);
		this.api.postJson("/api/files", Map.of("path", "Plain.md", "content", "Q3::A3 but untagged\n")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Prose.md", "content", "No cards here.\n")).ok(201);

		JsonNode tagged = this.api.get("/api/flashcards/notes").ok(200);
		assertThat(paths(tagged)).containsExactly("Cards/Bio.md");
		JsonNode note = tagged.get("notes").get(0);
		assertThat(note.get("content").asString()).isEqualTo("#flashcards/bio\nQ1::A1\n");
		assertThat(note.get("version").asString()).matches("[0-9a-f]{40}");

		Map<String, Object> change = new LinkedHashMap<>();
		change.put("tags", List.of("flashcards", "#srs"));
		change.put("newPerDay", 5);
		JsonNode config;
		try (SseRecorder others = SseRecorder.open(this.port, "observer-client-02", null)) {
			config = this.api.putJson("/api/flashcards/config", Map.of("config", change)).ok(200);
			others.awaitEvent("flashcards.changed");
			JsonNode event = others.frames()
				.stream()
				.filter((frame) -> frame.event().equals("flashcards.changed"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(event.get("config").get("newPerDay").asInt()).isEqualTo(5);
		}
		assertThat(list(config.get("tags"))).containsExactly("flashcards", "srs");
		assertThat(config.get("newPerDay").asInt()).isEqualTo(5);
		assertThat(config.get("reviewsPerDay").asInt()).isEqualTo(200);
		assertThat(paths(this.api.get("/api/flashcards/notes").ok(200))).containsExactly("Cards/Bio.md", "Cards/Geo.md");

		this.api.putJson("/api/flashcards/config", Map.of("config", Map.of("foldersAsDecks", true))).ok(200);
		assertThat(paths(this.api.get("/api/flashcards/notes").ok(200))).containsExactly("Cards/Bio.md", "Cards/Geo.md",
				"Plain.md");

		Map<String, Object> reset = new LinkedHashMap<>();
		reset.put("newPerDay", null);
		reset.put("foldersAsDecks", null);
		assertThat(this.api.putJson("/api/flashcards/config", Map.of("config", reset)).ok(200).get("newPerDay").asInt())
			.isEqualTo(20);
		Api.Reply invalid = this.api.putJson("/api/flashcards/config",
				Map.of("config", Map.of("retention", 1.5, "learningSteps", List.of("soon"))));
		assertThat(invalid.problem(400)).isEqualTo("bad-request");
		String file = Files.readString(vault.resolve(".notesapp/srs.json"), StandardCharsets.UTF_8);
		assertThat(file).contains("\"tags\": [\"flashcards\",\"srs\"]").doesNotContain("newPerDay");
	}

	private static List<String> paths(JsonNode response) {
		List<String> paths = new ArrayList<>();
		response.get("notes").forEach((n) -> paths.add(n.get("path").asString()));
		return paths;
	}

}
