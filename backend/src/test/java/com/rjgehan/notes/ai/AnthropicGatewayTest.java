package com.rjgehan.notes.ai;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.anthropic.core.ObjectMappers;
import com.rjgehan.notes.ai.ClaudeGateway.Block;
import com.rjgehan.notes.ai.ClaudeGateway.ClaudeException;
import com.rjgehan.notes.ai.ClaudeGateway.Message;
import com.sun.net.httpserver.HttpServer;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The SDK gateway against a local HTTP server that replays recorded Messages API streams: no request ever leaves the
 * machine, and no API key is needed.
 */
class AnthropicGatewayTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	private static final String KEY = "sk-ant-test-0123456789";

	record Received(String path, @Nullable String authorization, @Nullable String beta, JsonNode body) {
	}

	private final List<Received> received = new CopyOnWriteArrayList<>();

	private volatile int status = 200;

	private volatile String response = "";

	private HttpServer server;

	private AnthropicGateway gateway;

	@BeforeEach
	void start() throws IOException {
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.createContext("/", (exchange) -> {
			byte[] body = exchange.getRequestBody().readAllBytes();
			this.received.add(new Received(exchange.getRequestURI().getPath(),
					exchange.getRequestHeaders().getFirst("Authorization"),
					exchange.getRequestHeaders().getFirst("anthropic-beta"), MAPPER.readTree(body)));
			byte[] bytes = this.response.getBytes(StandardCharsets.UTF_8);
			exchange.getResponseHeaders()
				.add("Content-Type", (this.status == 200) ? "text/event-stream" : "application/json");
			exchange.sendResponseHeaders(this.status, bytes.length);
			try (OutputStream out = exchange.getResponseBody()) {
				out.write(bytes);
			}
		});
		this.server.start();
		this.gateway = new AnthropicGateway(Duration.ofSeconds(20),
				"http://127.0.0.1:" + this.server.getAddress().getPort());
	}

	@AfterEach
	void stop() {
		this.gateway.close();
		this.server.stop(0);
	}

	private static ClaudeGateway.Request request(boolean fallbacks) {
		return new ClaudeGateway.Request(KEY, "claude-sonnet-5-5", "System prompt",
				List.of(Message.user(new Block("<notes/>\n\nQuestion: first?", false)),
						Message.assistant("First answer."),
						Message.user(new Block("<notes/>\n\nQuestion: second?", true))),
				16000, "medium", fallbacks);
	}

	private static String sse(String... events) {
		StringBuilder out = new StringBuilder();
		for (String event : events) {
			JsonNode node = MAPPER.readTree(event);
			out.append("event: ").append(node.get("type").asString()).append('\n')
				.append("data: ").append(event).append("\n\n");
		}
		return out.toString();
	}

	private static final String START = """
			{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant",\
			"model":"claude-sonnet-5-5","content":[],"stop_reason":null,"stop_sequence":null,\
			"usage":{"input_tokens":1200,"output_tokens":1,"cache_read_input_tokens":800,\
			"cache_creation_input_tokens":100}}}""";

	private static String textStart(int index) {
		return "{\"type\":\"content_block_start\",\"index\":" + index
				+ ",\"content_block\":{\"type\":\"text\",\"text\":\"\"}}";
	}

	private static String textDelta(int index, String text) {
		return "{\"type\":\"content_block_delta\",\"index\":" + index
				+ ",\"delta\":{\"type\":\"text_delta\",\"text\":\"" + text + "\"}}";
	}

	private static String blockStop(int index) {
		return "{\"type\":\"content_block_stop\",\"index\":" + index + "}";
	}

	private static String messageDelta(String stop, int output) {
		return "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"" + stop
				+ "\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":" + output + "}}";
	}

	private static final String STOP = "{\"type\":\"message_stop\"}";

	/** Collects what the gateway reports. */
	static final class Recorder implements ClaudeGateway.Listener {

		final List<String> events = new ArrayList<>();

		@Override
		public void onText(String text) {
			this.events.add("text:" + text);
		}

		@Override
		public void onRestart(String model) {
			this.events.add("restart:" + model);
		}

	}

	@Test
	void streamsTheTextAndReportsUsageAndTheStopReason() throws Exception {
		this.response = sse(START, textStart(0), textDelta(0, "Hello "), textDelta(0, "[[Plan]]"), blockStop(0),
				messageDelta("end_turn", 42), STOP);
		Recorder recorder = new Recorder();
		ClaudeGateway.Result result = this.gateway.stream(request(true), recorder);
		assertThat(recorder.events).containsExactly("text:Hello ", "text:[[Plan]]");
		assertThat(result.model()).isEqualTo("claude-sonnet-5-5");
		assertThat(result.stopReason()).isEqualTo("end_turn");
		assertThat(result.fellBack()).isFalse();
		assertThat(result.usage()).isEqualTo(new AiModels.Usage(1200, 42, 800, 100));
		// 1200 × $2 + 42 × $10 + 800 × $0.20 + 100 × $2.50 per million tokens.
		assertThat(result.cost()).isCloseTo((1200 * 2.0 + 42 * 10.0 + 800 * 0.2 + 100 * 2.5) / 1e6,
				org.assertj.core.data.Offset.offset(1e-12));
	}

	@Test
	void sendsTheKeyTheFallbackAndTheCacheBreakpoint() throws Exception {
		this.response = sse(START, messageDelta("end_turn", 1), STOP);
		this.gateway.stream(request(true), new Recorder());
		assertThat(this.received).hasSize(1);
		Received sent = this.received.get(0);
		assertThat(sent.path()).isEqualTo("/v1/messages");
		// API version 2026-10-21 (SDK 3): the key travels as a bearer token.
		assertThat(sent.authorization()).isEqualTo("Bearer " + KEY);
		assertThat(sent.beta()).contains("server-side-fallback-2026-07-01");
		JsonNode body = sent.body();
		assertThat(body.get("model").asString()).isEqualTo("claude-sonnet-5-5");
		assertThat(body.get("stream").asBoolean()).isTrue();
		assertThat(body.get("fallbacks").asString()).isEqualTo("default");
		assertThat(body.get("output_config").get("effort").asString()).isEqualTo("medium");
		assertThat(body.has("thinking")).as("adaptive thinking is the default; nothing to send").isFalse();
		assertThat(body.get("system").get(0).get("text").asString()).isEqualTo("System prompt");
		JsonNode messages = body.get("messages");
		assertThat(messages).hasSize(3);
		assertThat(messages.get(0).get("content").get(0).has("cache_control")).isFalse();
		assertThat(messages.get(1).get("role").asString()).isEqualTo("assistant");
		assertThat(messages.get(2).get("content").get(0).get("cache_control").get("type").asString())
			.isEqualTo("ephemeral");
	}

	@Test
	void noFallbackIsRequestedForAModelWithoutOne() {
		String json = ObjectMappers.jsonMapper()
			.valueToTree(AnthropicGateway.params(request(false))._body())
			.toString();
		assertThat(json).doesNotContain("fallbacks");
		assertThat(AnthropicGateway.params(request(false)).betas()).isEmpty();
	}

	@Test
	void aFallbackModelTakingOverRestartsTheAnswerAndBothHopsArePriced() throws Exception {
		String fallback = """
				{"type":"content_block_start","index":1,"content_block":{"type":"fallback",\
				"from":{"model":"claude-sonnet-5-5"},"to":{"model":"claude-sonnet-5"},\
				"trigger":{"type":"refusal","category":"cyber"}}}""";
		String delta = """
				{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},\
				"usage":{"output_tokens":30,"iterations":[\
				{"type":"message","model":"claude-sonnet-5-5","input_tokens":1000,"output_tokens":10,\
				"cache_read_input_tokens":0,"cache_creation_input_tokens":0},\
				{"type":"fallback_message","model":"claude-sonnet-5","input_tokens":1000,"output_tokens":20,\
				"cache_read_input_tokens":0,"cache_creation_input_tokens":0}]}}""";
		this.response = sse(START, textStart(0), textDelta(0, "Partial"), blockStop(0), fallback, blockStop(1),
				textStart(2), textDelta(2, "Full answer"), blockStop(2), delta, STOP);
		Recorder recorder = new Recorder();
		ClaudeGateway.Result result = this.gateway.stream(request(true), recorder);
		assertThat(recorder.events).containsExactly("text:Partial", "restart:claude-sonnet-5", "text:Full answer");
		assertThat(result.fellBack()).isTrue();
		assertThat(result.model()).isEqualTo("claude-sonnet-5");
		assertThat(result.hops()).extracting(ClaudeGateway.Hop::model)
			.containsExactly("claude-sonnet-5-5", "claude-sonnet-5");
		assertThat(result.usage().outputTokens()).isEqualTo(30);
	}

	@Test
	void aRefusalIsReportedWithItsCategory() throws Exception {
		String delta = """
				{"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null,\
				"stop_details":{"type":"refusal","category":"bio","explanation":null}},\
				"usage":{"output_tokens":0}}""";
		this.response = sse(START, delta, STOP);
		ClaudeGateway.Result result = this.gateway.stream(request(true), new Recorder());
		assertThat(result.stopReason()).isEqualTo("refusal");
		assertThat(result.refusalCategory()).isEqualTo("bio");
	}

	@Test
	void aRefusedKeyIsAnAuthErrorWithoutTheKey() {
		this.status = 401;
		this.response = "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\","
				+ "\"message\":\"invalid x-api-key sk-ant-test-0123456789\"}}";
		assertThatThrownBy(() -> this.gateway.stream(request(true), new Recorder()))
			.isInstanceOfSatisfying(ClaudeException.class, (ex) -> {
				assertThat(ex.kind()).isEqualTo(ClaudeException.Kind.AUTH);
				assertThat(ex.getMessage()).contains("invalid x-api-key").doesNotContain(KEY);
			});
	}

	@Test
	void aBadRequestCarriesTheApiMessage() {
		this.status = 400;
		this.response = "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\","
				+ "\"message\":\"prompt is too long\"}}";
		assertThatThrownBy(() -> this.gateway.stream(request(true), new Recorder()))
			.isInstanceOfSatisfying(ClaudeException.class, (ex) -> {
				assertThat(ex.kind()).isEqualTo(ClaudeException.Kind.BAD_REQUEST);
				assertThat(ex.getMessage()).endsWith("prompt is too long");
			});
	}

	@Test
	void aListenerThatThrowsStopsTheStream() {
		this.response = sse(START, textStart(0), textDelta(0, "one"), textDelta(0, "two"), blockStop(0),
				messageDelta("end_turn", 2), STOP);
		List<String> seen = new ArrayList<>();
		assertThatThrownBy(() -> this.gateway.stream(request(true), (text) -> {
			seen.add(text);
			throw new IllegalStateException("gone");
		})).isInstanceOf(IllegalStateException.class);
		assertThat(seen).containsExactly("one");
	}

	@Test
	void aChangedKeyGetsANewClient() throws Exception {
		this.response = sse(START, messageDelta("end_turn", 1), STOP);
		this.gateway.stream(request(true), new Recorder());
		ClaudeGateway.Request other = new ClaudeGateway.Request("sk-ant-other-key-99", "claude-sonnet-5-5", "S",
				List.of(Message.user(new Block("Q", true))), 100, "low", false);
		this.gateway.stream(other, new Recorder());
		assertThat(this.received).extracting(Received::authorization)
			.containsExactly("Bearer " + KEY, "Bearer sk-ant-other-key-99");
	}

}
