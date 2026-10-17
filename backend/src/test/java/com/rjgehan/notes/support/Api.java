package com.rjgehan.notes.support;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Locale;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.client.EntityExchangeResult;
import org.springframework.test.web.servlet.client.RestTestClient;
import org.springframework.web.util.UriUtils;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Requests against the running server through {@link RestTestClient}, as the web client makes them: every request
 * carries {@code X-Client-Id} unless a test passes {@code "X-Client-Id", null}. URIs are relative and already encoded
 * (see {@link #enc}); extra headers are name/value pairs.
 */
public final class Api {

	public static final String CLIENT_ID = "itest-client-0001";

	public static final JsonMapper JSON = JsonMapper.builder().build();

	private final RestTestClient client;

	public Api(RestTestClient client) {
		this.client = client;
	}

	/** A response: status, headers and the raw body. */
	public record Reply(int status, HttpHeaders headers, byte[] body) {

		public String text() {
			return new String(this.body, StandardCharsets.UTF_8);
		}

		public JsonNode json() {
			return JSON.readTree(this.body);
		}

		public @Nullable String header(String name) {
			return this.headers.getFirst(name);
		}

		/** The problem {@code code}, after checking the status and the problem media type. */
		public String problem(int expectedStatus) {
			assertThat(this.status).as(text()).isEqualTo(expectedStatus);
			assertThat(header(HttpHeaders.CONTENT_TYPE)).startsWith("application/problem+json");
			JsonNode problem = json();
			String code = problem.get("code").asString();
			assertThat(problem.get("type").asString()).isEqualTo("urn:notesapp:problem:" + code);
			assertThat(problem.get("status").asInt()).isEqualTo(expectedStatus);
			return code;
		}

		/** The JSON body of a response with the expected status. */
		public JsonNode ok(int expectedStatus) {
			assertThat(this.status).as(text()).isEqualTo(expectedStatus);
			return json();
		}

	}

	/** {@code encodeURIComponent}: every character except the unreserved ones is percent-encoded, {@code +} too. */
	public static String enc(String value) {
		return UriUtils.encode(value, StandardCharsets.UTF_8);
	}

	/** The {@code v=} token of a tree entry (API.md §9.1). */
	public static String rawToken(JsonNode entry) {
		return entry.get("size").asLong() + "-" + Instant.parse(entry.get("mtime").asString()).toEpochMilli();
	}

	public Reply get(String uri, @Nullable String... headers) {
		return exchange(this.client.get().uri(URI.create(uri)), headers);
	}

	public Reply delete(String uri, @Nullable String... headers) {
		return exchange(this.client.delete().uri(URI.create(uri)), headers);
	}

	public Reply postJson(String uri, Object body, @Nullable String... headers) {
		return send(HttpMethod.POST, uri, MediaType.APPLICATION_JSON, json(body), headers);
	}

	public Reply putJson(String uri, Object body, @Nullable String... headers) {
		return send(HttpMethod.PUT, uri, MediaType.APPLICATION_JSON, json(body), headers);
	}

	public Reply postBytes(String uri, byte[] body, @Nullable String... headers) {
		return send(HttpMethod.POST, uri, MediaType.APPLICATION_OCTET_STREAM, body, headers);
	}

	public Reply putBytes(String uri, byte[] body, @Nullable String... headers) {
		return send(HttpMethod.PUT, uri, MediaType.APPLICATION_OCTET_STREAM, body, headers);
	}

	public Reply postEmpty(String uri, @Nullable String... headers) {
		return exchange(this.client.post().uri(URI.create(uri)), headers);
	}

	private Reply send(HttpMethod method, String uri, MediaType type, byte[] body, @Nullable String... headers) {
		return exchange(this.client.method(method).uri(URI.create(uri)).contentType(type).body(body), headers);
	}

	private Reply exchange(RestTestClient.RequestHeadersSpec<?> spec, @Nullable String... headers) {
		boolean clientId = true;
		for (int i = 0; i < headers.length; i += 2) {
			String name = headers[i];
			String value = headers[i + 1];
			if (name == null) {
				throw new IllegalArgumentException("header names cannot be null");
			}
			if (name.toLowerCase(Locale.ROOT).equals("x-client-id")) {
				clientId = false;
			}
			if (value != null) {
				spec.header(name, value);
			}
		}
		if (clientId) {
			spec.header("X-Client-Id", CLIENT_ID);
		}
		EntityExchangeResult<byte[]> result = spec.exchange().expectBody().returnResult();
		byte[] body = result.getResponseBody();
		return new Reply(result.getStatus().value(), result.getResponseHeaders(), (body != null) ? body : new byte[0]);
	}

	private static byte[] json(Object body) {
		return (body instanceof String text) ? text.getBytes(StandardCharsets.UTF_8) : JSON.writeValueAsBytes(body);
	}

}
