package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import tools.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Transcription is off until a service is configured (ROADMAP item 33): the default install. */
@NotesIntegrationTest
class TranscriptionOffIntegrationTest {

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

	@Test
	void theStatusSaysOffAndRequestsAreRefused() {
		Api api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
		JsonNode status = api.get("/api/transcription").ok(200);
		assertThat(status.get("enabled").asBoolean()).isFalse();
		assertThat(status.get("service").isNull()).isTrue();
		assertThat(status.get("maxBytes").asLong()).isEqualTo(25L * 1024 * 1024);
		api.postBytes("/api/attachments?name=" + Api.enc("Recording 1.m4a"), new byte[3]).ok(201);
		Reply refused = api.postJson("/api/transcriptions", Map.of("path", "Attachments/Recording 1.m4a"));
		assertThat(refused.problem(409)).isEqualTo("transcription-off");
		assertThat(refused.json().get("detail").asString()).contains("NOTES_TRANSCRIPTION_URL");
	}

}
