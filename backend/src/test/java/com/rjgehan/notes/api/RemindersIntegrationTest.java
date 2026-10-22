package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.interfaces.ECPublicKey;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.reminders.WebPushCrypto;
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

/** Reminders over HTTP (API.md §28): status, the zone, Web Push subscriptions, tests, snooze and done. */
@NotesIntegrationTest
class RemindersIntegrationTest {

	@TempDir
	static Path vault;

	@TempDir
	static Path secrets;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault, Map.of());
		registry.add("notes.secrets-dir", () -> secrets.toString());
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
	void statusZoneAndSettings() {
		JsonNode settings = this.api.get("/api/settings").ok(200).get("settings").get("reminders");
		assertThat(settings.get("webPush").asBoolean()).isFalse();
		assertThat(settings.get("ntfy").asBoolean()).isFalse();
		assertThat(settings.get("inApp").asBoolean()).isFalse();
		assertThat(settings.get("ntfyTitleOnly").asBoolean()).isTrue();

		JsonNode status = this.api.get("/api/reminders/status").ok(200);
		assertThat(status.get("webPush").get("available").asBoolean()).isTrue();
		assertThat(status.get("ntfy").get("configured").asBoolean()).isFalse();
		assertThat(status.get("ntfy").get("reason").asString()).contains("ntfy.json");
		assertThat(status.get("inApp").get("connections").asInt()).isZero();

		assertThat(this.api.putJson("/api/reminders/zone", Map.of("zone", "Mars/Olympus")).problem(400))
			.isEqualTo("bad-request");
		this.api.putJson("/api/reminders/zone", Map.of("zone", "Europe/Berlin")).ok(204);
		JsonNode after = this.api.get("/api/reminders/status").ok(200);
		assertThat(after.get("zone").asString()).isEqualTo("Europe/Berlin");
		assertThat(after.get("zoneReported").asBoolean()).isTrue();
		assertThat(Files.exists(vault.resolve(".notesapp/reminders.json"))).isTrue();

		JsonNode test = this.api.postJson("/api/reminders/test", Map.of("route", "inApp")).ok(200);
		assertThat(test.get("sent").asBoolean()).isFalse();
		assertThat(test.get("error").asString()).isEqualTo("no NotesApp tab is open");
		assertThat(this.api.postJson("/api/reminders/test", Map.of("route", "pigeon")).problem(400))
			.isEqualTo("bad-request");
	}

	@Test
	void devicesSubscribeAndUnsubscribe() {
		String publicKey = this.api.postEmpty("/api/push/key").ok(200).get("publicKey").asString();
		assertThat(WebPushCrypto.fromBase64Url(publicKey)).hasSize(65);
		assertThat(this.api.postEmpty("/api/push/key").ok(200).get("publicKey").asString()).isEqualTo(publicKey);
		assertThat(Files.exists(secrets.resolve("push.json"))).isTrue();

		KeyPair device = WebPushCrypto.generateKeyPair();
		Map<String, Object> subscription = Map.of("endpoint", "https://push.example.com/send/abc", "keys",
				Map.of("p256dh", WebPushCrypto.base64Url(WebPushCrypto.encodePublic((ECPublicKey) device.getPublic())),
						"auth", WebPushCrypto.base64Url(new byte[16])),
				"name", "iPhone");
		JsonNode created = this.api.postJson("/api/push/subscriptions", subscription).ok(201);
		assertThat(created.get("name").asString()).isEqualTo("iPhone");
		assertThat(created.has("endpoint")).isFalse();
		String id = created.get("id").asString();

		JsonNode status = this.api.get("/api/reminders/status").ok(200);
		assertThat(status.get("webPush").get("publicKey").asString()).isEqualTo(publicKey);
		assertThat(status.get("webPush").get("devices")).hasSize(1);

		assertThat(this.api
			.postJson("/api/push/subscriptions", Map.of("endpoint", "http://push.example.com/x", "keys", Map.of()))
			.problem(400)).isEqualTo("bad-request");
		this.api.delete("/api/push/subscriptions/" + id).ok(204);
		assertThat(this.api.delete("/api/push/subscriptions/" + id).problem(404)).isEqualTo("not-found");
		assertThat(this.api.get("/api/reminders/status").ok(200).get("webPush").get("devices")).isEmpty();
	}

	@Test
	void snoozeAndDoneActOnTheTaskTheReminderBelongsTo() {
		JsonNode task = this.api
			.postJson("/api/tasks",
					Map.of("title", "Pay rent", "due", "2030-01-05", "reminders", List.of(Map.of("at", "2030-01-05T09:00"))))
			.ok(201)
			.get("task");
		String id = task.get("id").asString();
		assertThat(this.api.get("/api/reminders/status").ok(200).get("upcoming").get(0).get("taskId").asString())
			.isEqualTo(id);

		assertThat(this.api.postJson("/api/reminders/snooze", Map.of("taskId", id)).problem(400))
			.isEqualTo("bad-request");
		JsonNode snoozed = this.api
			.postJson("/api/reminders/snooze", Map.of("taskId", id, "at", "2030-01-05T09:00", "minutes", 15))
			.ok(200);
		assertThat(snoozed.get("changed").asBoolean()).isTrue();
		assertThat(snoozed.get("until").isString()).isTrue();

		JsonNode stale = this.api.postJson("/api/reminders/done", Map.of("taskId", id, "at", "2030-01-04T09:00"))
			.ok(200);
		assertThat(stale.get("changed").asBoolean()).isFalse();
		JsonNode done = this.api.postJson("/api/reminders/done", Map.of("taskId", id, "at", "2030-01-05T09:00"))
			.ok(200);
		assertThat(done.get("changed").asBoolean()).isTrue();
		assertThat(this.api.get("/api/tasks/" + id).ok(200).get("status").asString()).isEqualTo("done");
		JsonNode again = this.api.postJson("/api/reminders/done", Map.of("taskId", id, "at", "2030-01-05T09:00"))
			.ok(200);
		assertThat(again.get("changed").asBoolean()).isFalse();
	}

}
