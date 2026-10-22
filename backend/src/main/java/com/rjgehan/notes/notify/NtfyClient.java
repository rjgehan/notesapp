package com.rjgehan.notes.notify;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

import com.rjgehan.notes.vaults.ServerWide;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * Publishes one ntfy message (ROADMAP items 9 and 38) as JSON to the server's root URL, so titles and messages need no
 * header encoding. The token, when there is one, goes in an {@code Authorization: Bearer} header. Redirects are not
 * followed, so the token never goes anywhere but the configured server. This is the app's only outbound call besides
 * the mirror's push, and it is made only when {@code ntfy.json} configures a server.
 */
@Component
@ServerWide
public class NtfyClient {

	private static final Duration TIMEOUT = Duration.ofSeconds(15);

	/** One notification. {@code priority} is ntfy's 1 (min) to 5 (max); {@code click} opens when it is tapped. */
	public record Message(String title, String body, int priority, List<String> tags, @Nullable URI click) {
	}

	private final HttpClient http;

	private final JsonMapper mapper;

	public NtfyClient(JsonMapper mapper) {
		this.mapper = mapper;
		this.http = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NEVER)
			.build();
	}

	/**
	 * Sends {@code message} to {@code topic} on the configured server.
	 * @throws IOException when the server cannot be reached or answers with anything but 2xx; the message names the
	 * HTTP status only, never the topic or the token
	 */
	public void publish(NtfyConfig config, String topic, Message message) throws IOException, InterruptedException {
		ObjectNode body = this.mapper.createObjectNode();
		body.put("topic", topic);
		body.put("title", message.title());
		body.put("message", message.body());
		body.put("priority", message.priority());
		message.tags().forEach(body.putArray("tags")::add);
		if (message.click() != null) {
			body.put("click", message.click().toString());
		}
		HttpRequest.Builder request = HttpRequest.newBuilder(config.server())
			.timeout(TIMEOUT)
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofByteArray(this.mapper.writeValueAsBytes(body)));
		if (config.token() != null) {
			request.header("Authorization", "Bearer " + config.token());
		}
		HttpResponse<Void> response = this.http.send(request.build(), HttpResponse.BodyHandlers.discarding());
		if (response.statusCode() / 100 != 2) {
			throw new IOException("ntfy answered HTTP " + response.statusCode());
		}
	}

}
