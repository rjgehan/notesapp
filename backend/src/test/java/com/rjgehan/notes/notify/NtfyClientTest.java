package com.rjgehan.notes.notify;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.sun.net.httpserver.HttpServer;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Publishing to ntfy as JSON, against a local HTTP server standing in for it. */
class NtfyClientTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	/** One request the fake server received. */
	record Received(String method, String path, @Nullable String authorization, String contentType, JsonNode body) {
	}

	private final List<Received> received = new CopyOnWriteArrayList<>();

	private volatile int status = 200;

	private HttpServer server;

	@BeforeEach
	void start() throws IOException {
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.createContext("/", (exchange) -> {
			byte[] body = exchange.getRequestBody().readAllBytes();
			this.received.add(new Received(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
					exchange.getRequestHeaders().getFirst("Authorization"),
					exchange.getRequestHeaders().getFirst("Content-Type"), MAPPER.readTree(body)));
			if (this.status == 302) {
				exchange.getResponseHeaders().add("Location", "http://127.0.0.1:9/elsewhere");
			}
			exchange.sendResponseHeaders(this.status, -1);
			exchange.close();
		});
		this.server.start();
	}

	@AfterEach
	void stop() {
		this.server.stop(0);
	}

	private NtfyConfig config(@Nullable String token) {
		URI url = URI.create("http://127.0.0.1:" + this.server.getAddress().getPort());
		return new NtfyConfig(url, "default-topic", token, new NtfyConfig.Alerts(true, "alerts-topic"));
	}

	@Test
	void aMessageIsPostedAsJsonWithTheToken() throws Exception {
		new NtfyClient(MAPPER).publish(config("tk_abc"), "alerts-topic", new NtfyClient.Message("Title é",
				"Body\nline two", 4, List.of("warning"), URI.create("https://notes.example.ts.net/x/status")));
		assertThat(this.received).hasSize(1);
		Received request = this.received.get(0);
		assertThat(request.method()).isEqualTo("POST");
		assertThat(request.path()).isEqualTo("/");
		assertThat(request.authorization()).isEqualTo("Bearer tk_abc");
		assertThat(request.contentType()).isEqualTo("application/json");
		assertThat(request.body().get("topic").asString()).isEqualTo("alerts-topic");
		assertThat(request.body().get("title").asString()).isEqualTo("Title é");
		assertThat(request.body().get("message").asString()).isEqualTo("Body\nline two");
		assertThat(request.body().get("priority").asInt()).isEqualTo(4);
		assertThat(request.body().get("tags").get(0).asString()).isEqualTo("warning");
		assertThat(request.body().get("click").asString()).isEqualTo("https://notes.example.ts.net/x/status");
	}

	@Test
	void withoutATokenThereIsNoAuthorizationAndNoClickWithoutAPage() throws Exception {
		new NtfyClient(MAPPER).publish(config(null), "t", new NtfyClient.Message("T", "B", 3, List.of(), null));
		assertThat(this.received.get(0).authorization()).isNull();
		assertThat(this.received.get(0).body().has("click")).isFalse();
	}

	@Test
	void anErrorStatusFailsWithoutTheTopicOrTheToken() {
		this.status = 403;
		assertThatThrownBy(() -> new NtfyClient(MAPPER).publish(config("tk_s3cr3t"), "secret-topic",
				new NtfyClient.Message("T", "B", 3, List.of(), null)))
			.isInstanceOf(IOException.class)
			.hasMessage("ntfy answered HTTP 403");
	}

	@Test
	void aRedirectIsNotFollowed() {
		this.status = 302;
		assertThatThrownBy(() -> new NtfyClient(MAPPER).publish(config("tk_s3cr3t"), "t",
				new NtfyClient.Message("T", "B", 3, List.of(), null)))
			.hasMessage("ntfy answered HTTP 302");
		assertThat(this.received).hasSize(1);
	}

}
