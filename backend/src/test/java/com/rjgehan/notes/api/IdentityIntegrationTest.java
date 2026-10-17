package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;
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

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The identity allowlist as in production (DESIGN §8.1 integration item 3 with {@code allow-default=false}): every
 * request needs an allowed {@code Tailscale-User-Login}, except the health endpoints.
 */
@NotesIntegrationTest
class IdentityIntegrationTest {

	private static final String LOGIN = "rjgehan@github";

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.identity.allow-default", "false", "notes.identity.allowed-logins", LOGIN));
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

	@Test
	void requestsWithoutALoginAreRefusedButHealthIsNot() {
		for (String uri : List.of("/api/tree", "/api/me", "/api/files/raw?path=x.png", "/n/Note.md",
				"/api/events?clientId=sse-client-0001")) {
			Reply reply = this.api.get(uri);
			assertThat(reply.problem(403)).as(uri).isEqualTo("identity-not-allowed");
			assertThat(reply.json().get("title").asString()).isEqualTo("Identity not allowed");
		}
		assertThat(this.api.postJson("/api/files", Map.of("path", "x.md")).problem(403))
			.isEqualTo("identity-not-allowed");
		for (String health : List.of("/readyz", "/livez", "/actuator/health")) {
			Reply reply = this.api.get(health);
			assertThat(reply.status()).as(health).isEqualTo(200);
			assertThat(reply.json().get("status").asString()).isEqualTo("UP");
		}
	}

	@Test
	void loginsOutsideTheAllowlistAreRefused() {
		assertThat(this.api.get("/api/tree", "Tailscale-User-Login", "someone-else@github").problem(403))
			.isEqualTo("identity-not-allowed");
		assertThat(this.api.get("/api/tree", "Tailscale-User-Login", "").problem(403))
			.isEqualTo("identity-not-allowed");
	}

	@Test
	void anAllowedLoginIsAdmittedAndAttributed() {
		String[] identity = { "Tailscale-User-Login", LOGIN, "Tailscale-User-Name",
				"=?utf-8?q?R=2E_J=2E_G=C3=A9han?=", "Tailscale-User-Profile-Pic", "" };
		JsonNode me = this.api.get("/api/me", identity).ok(200);
		assertThat(me.get("login").asString()).isEqualTo(LOGIN);
		assertThat(me.get("name").asString()).isEqualTo("R. J. Géhan");
		assertThat(me.has("profilePicUrl")).isTrue();
		assertThat(me.get("profilePicUrl").isNull()).isTrue();
		assertThat(me.get("source").asString()).isEqualTo("tailscale");
		JsonNode withPicture = this.api
			.get("/api/me", "Tailscale-User-Login", LOGIN, "Tailscale-User-Profile-Pic", "https://example.com/p.png")
			.ok(200);
		assertThat(withPicture.get("profilePicUrl").asString()).isEqualTo("https://example.com/p.png");
		assertThat(withPicture.get("name").asString()).isNotBlank();

		this.api.postJson("/api/files", Map.of("path", "Mine.md", "content", "x"), identity).ok(201);
		this.api.postEmpty("/api/history/commit", identity).ok(200);
		JsonNode entry = this.api.get("/api/history?path=Mine.md", identity).ok(200).get("entries").get(0);
		assertThat(entry.get("authorLogin").asString()).isEqualTo(LOGIN);
		assertThat(entry.get("authorName").asString()).isEqualTo("R. J. Géhan");
		JsonNode trashed = this.api.delete("/api/files?path=Mine.md", identity).ok(200);
		assertThat(trashed.get("deletedBy").asString()).isEqualTo(LOGIN);
	}

}
