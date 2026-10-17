package com.rjgehan.notes.api;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.support.SseRecorder.Frame;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.test.web.servlet.assertj.MvcTestResult;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The event stream (DESIGN §8.1 integration item 11): {@code hello} first, its replay decision, heartbeats and the
 * stream lifetime. The replay buffer is 8 events and streams end after 4 s here, so both limits can be observed;
 * batches never commit on their own, so no {@code history.committed} interleaves.
 */
@NotesIntegrationTest
@AutoConfigureMockMvc
class EventStreamIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.sse.heartbeat", "500ms", "notes.sse.timeout", "4s", "notes.sse.replay-buffer", "8",
						"notes.git.commit-quiet-period", "1h", "notes.git.commit-max-delay", "1h"));
	}

	@LocalServerPort
	int port;

	@Autowired
	RestTestClient client;

	@Autowired
	MockMvcTester mvc;

	@Autowired
	EventHub hub;

	@Autowired
	CommitBatcher batcher;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private String treeEventId() {
		return this.api.get("/api/tree").ok(200).get("eventId").asString();
	}

	private void create(String path) {
		this.api.postJson("/api/files", Map.of("path", path)).ok(201);
	}

	@Test
	void theStreamStartsWithHello() throws Exception {
		MvcTestResult result = this.mvc.get()
			.uri("/api/events?clientId=mvc-client-0001")
			.header("Host", "localhost")
			.accept(MediaType.TEXT_EVENT_STREAM)
			.asyncExchange();
		assertThat(result.getMvcResult().getRequest().isAsyncStarted()).isTrue();
		assertThat(result.getResponse().getContentType()).startsWith("text/event-stream");
		assertThat(result.getResponse().getHeader("Cache-Control")).isEqualTo("no-cache, no-transform");
		assertThat(result.getResponse().getHeader("X-Accel-Buffering")).isEqualTo("no");
		assertThat(result.getResponse().getHeader("X-Notes-Build")).isEqualTo("dev");
		await().atMost(Duration.ofSeconds(5)).until(() -> result.getResponse().getContentAsString().contains("\n\n"));
		String frame = result.getResponse().getContentAsString().split("\n\n")[0];
		List<String> lines = List.of(frame.split("\n"));
		assertThat(lines).contains("retry:3000", "event:hello", "id:" + this.hub.headEventId());
		JsonNode hello = Api.JSON.readTree(lines.stream()
			.filter((line) -> line.startsWith("data:"))
			.findFirst()
			.orElseThrow()
			.substring("data:".length()));
		assertThat(hello.get("bootId").asString()).isEqualTo(this.hub.bootId());
		assertThat(hello.get("eventId").asString()).isEqualTo(this.hub.headEventId());
		assertThat(hello.get("resync").asBoolean()).isTrue();
		assertThat(hello.get("replayed").asInt()).isZero();
		assertThat(hello.get("buildSha").asString()).isEqualTo("dev");
		assertThat(Instant.parse(hello.get("serverTime").asString())).isNotNull();
		assertThat(hello.get("serverTime").asString()).matches(".*\\.\\d{3}Z");
		assertThat(hello.size()).isEqualTo(6);
	}

	@Test
	void theStreamCarriesItsHeadersOverHttp() throws Exception {
		HttpRequest request = HttpRequest
			.newBuilder(URI.create("http://localhost:" + this.port + "/api/events?clientId=http-client-01"))
			.header("Accept", "text/event-stream")
			.build();
		HttpResponse<InputStream> response = HttpClient.newHttpClient()
			.send(request, HttpResponse.BodyHandlers.ofInputStream());
		response.body().close();
		assertThat(response.statusCode()).isEqualTo(200);
		assertThat(response.headers().firstValue("Content-Type").orElseThrow()).startsWith("text/event-stream");
		assertThat(response.headers().firstValue("Cache-Control").orElseThrow()).isEqualTo("no-cache, no-transform");
		assertThat(response.headers().firstValue("X-Accel-Buffering").orElseThrow()).isEqualTo("no");
		assertThat(response.headers().firstValue("X-Notes-Build").orElseThrow()).isEqualTo("dev");
	}

	@Test
	void aReplayableIdGetsTheMissedEventsWithoutEchoes() {
		String since = treeEventId();
		create("replay-a.md");
		create("replay-b.md");
		try (SseRecorder other = SseRecorder.open(this.port, "replay-other-01", since)) {
			List<Frame> frames = other.awaitFrames((all) -> all.size() >= 3);
			Frame hello = frames.get(0);
			assertThat(hello.event()).isEqualTo("hello");
			assertThat(hello.id()).isEqualTo(since);
			assertThat(hello.data().get("resync").asBoolean()).isFalse();
			assertThat(hello.data().get("replayed").asInt()).isEqualTo(2);
			assertThat(frames.subList(1, 3)).extracting(Frame::event).containsExactly("file.created", "file.created");
			assertThat(frames.get(1).data().get("file").get("path").asString()).isEqualTo("replay-a.md");
			assertThat(frames.get(2).id()).isEqualTo(hello.data().get("eventId").asString());
		}
		try (SseRecorder origin = SseRecorder.open(this.port, Api.CLIENT_ID, since)) {
			Frame hello = origin.frames().get(0);
			assertThat(hello.data().get("resync").asBoolean()).isFalse();
			assertThat(hello.data().get("replayed").asInt()).isZero();
		}
	}

	@Test
	void unreplayableIdsGetAResyncWithTheHeadId() {
		String head = treeEventId();
		String foreign = "zzzzzz.1";
		try (SseRecorder recorder = SseRecorder.open(this.port, "resync-client-01", foreign)) {
			Frame hello = recorder.frames().get(0);
			assertThat(hello.data().get("resync").asBoolean()).isTrue();
			assertThat(hello.data().get("replayed").asInt()).isZero();
			assertThat(hello.id()).isEqualTo(head);
		}
		for (int i = 0; i < 9; i++) {
			create("old-" + i + ".md");
		}
		try (SseRecorder recorder = SseRecorder.open(this.port, "resync-client-02", head)) {
			Frame hello = recorder.frames().get(0);
			assertThat(hello.data().get("resync").asBoolean()).isTrue();
			assertThat(hello.id()).isEqualTo(this.hub.headEventId());
		}
		try (SseRecorder recorder = SseRecorder.open(this.port, "resync-client-03", "not-an-id")) {
			assertThat(recorder.frames().get(0).data().get("resync").asBoolean()).isTrue();
		}
	}

	@Test
	void theLastEventIdHeaderWinsOverTheQueryParameter() throws Exception {
		String since = treeEventId();
		create("header-a.md");
		HttpRequest request = HttpRequest
			.newBuilder(URI.create("http://localhost:" + this.port
					+ "/api/events?clientId=header-client-1&lastEventId=" + Api.enc("zzzz.1")))
			.header("Accept", "text/event-stream")
			.header("Last-Event-ID", since)
			.build();
		HttpResponse<Stream<String>> response = HttpClient.newHttpClient()
			.send(request, HttpResponse.BodyHandlers.ofLines());
		try (var lines = response.body()) {
			List<String> hello = lines.takeWhile((line) -> !line.isEmpty()).toList();
			assertThat(hello).contains("id:" + since);
			assertThat(hello).anyMatch((line) -> line.contains("\"resync\":false") && line.contains("\"replayed\":1"));
		}
	}

	@Test
	void pingsKeepTheStreamAliveWithoutIdsAndTheStreamEnds() {
		try (SseRecorder recorder = SseRecorder.open(this.port, "ping-client-001", null)) {
			recorder.awaitFrames((frames) -> frames.stream().anyMatch((frame) -> frame.event().equals("ping")));
			Frame ping = recorder.frames()
				.stream()
				.filter((frame) -> frame.event().equals("ping"))
				.findFirst()
				.orElseThrow();
			assertThat(ping.id()).isNull();
			assertThat(ping.data().get("serverTime").asString()).matches(".*\\.\\d{3}Z");
			assertThat(ping.data().size()).isEqualTo(1);
			String head = this.hub.headEventId();
			await().atMost(Duration.ofSeconds(10)).until(recorder::ended);
			assertThat(this.hub.headEventId()).isEqualTo(head);
		}
	}

	@Test
	void theClientIdIsRequired() {
		assertThat(this.api.get("/api/events").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/events?clientId=short").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/events?clientId=" + Api.enc("has spaces in it")).problem(400))
			.isEqualTo("bad-request");
	}

}
