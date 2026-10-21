package com.rjgehan.notes.api;

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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Ask your vault over HTTP (API.md §20): status, refusals as problem documents, and an answer streamed as server-sent
 * events. The server runs with {@code notes.ai.fake=true}, so nothing is sent to Anthropic.
 */
@NotesIntegrationTest
class AiIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.ai.fake", "true"));
	}

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	private Api api;

	/** One server-sent event of a response body. */
	record Sse(String event, JsonNode data) {
	}

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private static List<Sse> events(String body) {
		List<Sse> events = new ArrayList<>();
		for (String frame : body.split("\n\n")) {
			String event = null;
			StringBuilder data = new StringBuilder();
			for (String line : frame.split("\n")) {
				if (line.startsWith("event:")) {
					event = line.substring(6).strip();
				}
				else if (line.startsWith("data:")) {
					data.append(line.substring(5));
				}
			}
			if (event != null) {
				events.add(new Sse(event, Api.JSON.readTree(data.toString())));
			}
		}
		return events;
	}

	private void setAi(boolean enabled) {
		JsonNode current = this.api.get("/api/settings").ok(200);
		ObjectNode settings = (ObjectNode) current.get("settings").deepCopy();
		((ObjectNode) settings.get("ai")).put("enabled", enabled);
		this.api.putJson("/api/settings",
				Map.of("settings", settings, "baseVersion", current.get("version").asString())).ok(200);
	}

	@Test
	void anAnswerStreamsAsServerSentEventsAndExcludedNotesStayHome() {
		this.api.postJson("/api/files", Map.of("path", "Projects/Kitchen.md", "content",
				"# Kitchen\n\nThe kitchen budget is 12k.")).ok(201);
		this.api.postJson("/api/files", Map.of("path", "Private/Diary.md", "content",
				"Secret: the kitchen budget scares me.")).ok(201);

		JsonNode off = this.api.get("/api/ai/status").ok(200);
		assertThat(off.get("state").asString()).isEqualTo("off");
		assertThat(off.get("model").asString()).isEqualTo("claude-sonnet-5-5");
		assertThat(off.get("models")).hasSize(3);
		assertThat(off.get("keyFile").asString()).isEqualTo("claude-token");
		assertThat(off.get("provider").asString()).isEqualTo("claude-code");
		// Asking while off is a problem document, also for a client that asked for an event stream.
		Reply refused = this.api.postJson("/api/ai/ask", Map.of("question", "kitchen budget?"), "Accept",
				"text/event-stream, application/problem+json");
		assertThat(refused.problem(409)).isEqualTo("ai-unavailable");
		assertThat(refused.json().get("reason").asString()).isEqualTo("off");

		setAi(true);
		JsonNode ready = this.api.get("/api/ai/status").ok(200);
		assertThat(ready.get("state").asString()).isEqualTo("ready");
		assertThat(ready.get("fake").asBoolean()).isTrue();

		Reply answer = this.api.postJson("/api/ai/ask", Map.of("question", "What is the kitchen budget?"),
				"Accept", "text/event-stream, application/problem+json");
		assertThat(answer.status()).isEqualTo(200);
		assertThat(answer.header("Content-Type")).startsWith("text/event-stream");
		assertThat(answer.header("Cache-Control")).isEqualTo("no-store");
		List<Sse> events = events(answer.text());
		assertThat(events.get(0).event()).isEqualTo("start");
		JsonNode start = events.get(0).data();
		assertThat(start.get("model").asString()).isEqualTo("claude-sonnet-5-5");
		assertThat(start.get("sources").get(0).get("path").asString()).isEqualTo("Projects/Kitchen.md");
		assertThat(start.get("excluded").asInt()).isEqualTo(1);
		assertThat(answer.text()).doesNotContain("Private/Diary").doesNotContain("Secret");
		String text = events.stream()
			.filter((e) -> e.event().equals("delta"))
			.map((e) -> e.data().get("text").asString())
			.reduce("", String::concat);
		assertThat(text).contains("[[Projects/Kitchen]]");
		Sse done = events.get(events.size() - 1);
		assertThat(done.event()).isEqualTo("done");
		assertThat(done.data().get("stopReason").asString()).isEqualTo("end_turn");
		assertThat(done.data().get("usage").get("inputTokens").asLong()).isPositive();
		assertThat(this.api.get("/api/ai/status").ok(200).get("monthRequests").asInt()).isEqualTo(1);

		Reply excluded = this.api.postJson("/api/ai/summarize",
				Map.of("scope", "note", "path", "Private/Diary.md"), "Accept", "text/event-stream");
		assertThat(excluded.problem(403)).isEqualTo("ai-excluded");

		Reply noClient = this.api.postJson("/api/ai/ask", Map.of("question", "x"), "X-Client-Id", null);
		assertThat(noClient.problem(403)).isEqualTo("client-id-required");
	}

}
