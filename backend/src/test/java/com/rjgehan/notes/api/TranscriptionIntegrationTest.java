package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.transcribe.TranscriptionEngine;
import com.rjgehan.notes.transcribe.TranscriptionEngine.AudioFile;
import com.rjgehan.notes.transcribe.TranscriptionEngine.Transcript;
import tools.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Voice-note transcription (API.md §23, ROADMAP item 33) with the speech-to-text service replaced by a fake: the
 * status, recordings uploaded as attachments and transcribed, the checks (kind, size, path), the kept transcript and
 * joined requests, and the service's failures. The service is limited to 4 KB recordings here.
 */
@NotesIntegrationTest
class TranscriptionIntegrationTest {

	/** What the fake service was asked, and what it answers. */
	static final class FakeEngine implements TranscriptionEngine {

		final List<AudioFile> calls = new CopyOnWriteArrayList<>();

		volatile IOException failure;

		volatile CountDownLatch gate;

		volatile CountDownLatch entered;

		@Override
		public Transcript transcribe(AudioFile audio) throws IOException, InterruptedException {
			this.calls.add(audio);
			if (this.entered != null) {
				this.entered.countDown();
			}
			if (this.gate != null) {
				this.gate.await(10, TimeUnit.SECONDS);
			}
			if (this.failure != null) {
				throw this.failure;
			}
			return new Transcript("Words of " + audio.name() + " (" + audio.size() + " bytes)", "en");
		}

	}

	static final FakeEngine fake = new FakeEngine();

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.transcription.url", "http://transcriber:secret@whisper.test:9000/base",
						"notes.transcription.max-size", "4KB"));
	}

	@TestBean
	TranscriptionEngine engine;

	static TranscriptionEngine engine() {
		return fake;
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

	@AfterEach
	void reset() {
		fake.calls.clear();
		fake.failure = null;
		fake.gate = null;
		fake.entered = null;
	}

	private String record(String name, byte[] bytes) {
		JsonNode attached = this.api
			.postBytes("/api/attachments?name=" + Api.enc(name) + "&source=" + Api.enc("Voice/Ideas.md"), bytes)
			.ok(201);
		assertThat(attached.get("markdown").asString()).isEqualTo("![[" + name + "]]");
		return attached.get("file").get("path").asString();
	}

	private Reply transcribe(String path) {
		return this.api.postJson("/api/transcriptions", Map.of("path", path));
	}

	@Test
	void theStatusSaysTranscriptionIsOnWithoutTheServicesCredentials() {
		JsonNode status = this.api.get("/api/transcription").ok(200);
		assertThat(status.get("enabled").asBoolean()).isTrue();
		assertThat(status.get("service").asString()).isEqualTo("whisper-asr at http://whisper.test:9000");
		assertThat(status.get("language").isNull()).isTrue();
		assertThat(status.get("maxBytes").asLong()).isEqualTo(4096);
		assertThat(this.api.get("/api/transcription").text()).doesNotContain("secret");
	}

	@Test
	void aRecordingIsTranscribedOnceAndAgainWhenItChanges() {
		String path = record("Recording 20261021143000.m4a", new byte[300]);
		assertThat(path).isEqualTo("Attachments/Recording 20261021143000.m4a");

		JsonNode first = transcribe(path).ok(200);
		assertThat(first.get("path").asString()).isEqualTo(path);
		assertThat(first.get("text").asString()).isEqualTo("Words of Recording 20261021143000.m4a (300 bytes)");
		assertThat(first.get("language").asString()).isEqualTo("en");
		assertThat(fake.calls).hasSize(1);
		assertThat(fake.calls.getFirst().contentType()).isEqualTo("audio/mp4");
		assertThat(fake.calls.getFirst().file()).hasFileName("Recording 20261021143000.m4a");
		assertThat(fake.calls.getFirst().size()).isEqualTo(300);

		// A retry (the phone slept through the answer) gets the kept transcript.
		JsonNode again = transcribe(path).ok(200);
		assertThat(again.get("text").asString()).isEqualTo(first.get("text").asString());
		assertThat(again.get("millis").asLong()).isZero();
		assertThat(fake.calls).hasSize(1);

		// A new version of the file is transcribed again.
		this.api.putBytes("/api/files/raw?path=" + Api.enc(path) + "&onConflict=overwrite", new byte[500]).ok(200);
		assertThat(transcribe(path).ok(200).get("text").asString()).endsWith("(500 bytes)");
		assertThat(fake.calls).hasSize(2);
	}

	@Test
	void webmRecordingsAndVideosCountAsAudio() {
		String path = record("Recording 20261021150000.webm", new byte[10]);
		assertThat(transcribe(path).ok(200).get("text").asString()).startsWith("Words of Recording 20261021150000.webm");
		assertThat(fake.calls.getFirst().contentType()).isEqualTo("video/webm");
	}

	@Test
	void onlyExistingAudioWithinTheSizeLimitIsSent() {
		this.api.postJson("/api/files", Map.of("path", "Voice/Ideas.md", "content", "# Ideas\n")).ok(201);
		Reply note = transcribe("Voice/Ideas.md");
		assertThat(note.problem(415)).isEqualTo("not-audio");
		assertThat(transcribe("Attachments/missing.m4a").problem(404)).isEqualTo("not-found");
		assertThat(transcribe("../outside.m4a").status()).isEqualTo(400);
		assertThat(transcribe(".git/config").problem(403)).isEqualTo("reserved-path");
		assertThat(this.api.postJson("/api/transcriptions", Map.of("path", " ")).problem(400)).isEqualTo("bad-request");
		String large = record("Long memo.m4a", new byte[5000]);
		assertThat(transcribe(large).problem(413)).isEqualTo("too-large");
		assertThat(fake.calls).isEmpty();
	}

	@Test
	void aFailingServiceIsUnavailableWithItsReasonAndNothingIsKept() {
		String path = record("Recording 20261021160000.m4a", new byte[20]);
		fake.failure = new IOException("the service answered HTTP 500 (Model base could not be loaded)");
		Reply failed = transcribe(path);
		// 503, not 502: clients take a 502 for the proxy during a deploy and go offline (API.md §3).
		assertThat(failed.problem(503)).isEqualTo("transcription-failed");
		assertThat(failed.json().get("detail").asString())
			.isEqualTo("The transcription service failed: the service answered HTTP 500 (Model base could not be loaded)");
		fake.failure = new java.net.ConnectException();
		assertThat(transcribe(path).json().get("detail").asString())
			.isEqualTo("The transcription service failed: cannot connect to http://whisper.test:9000");
		fake.failure = null;
		assertThat(transcribe(path).ok(200).get("text").asString()).startsWith("Words of");
		assertThat(fake.calls).hasSize(3);
	}

	@Test
	void aSecondRequestForTheSameRecordingJoinsTheRunningOne() throws Exception {
		String path = record("Recording 20261021170000.m4a", new byte[40]);
		fake.gate = new CountDownLatch(1);
		fake.entered = new CountDownLatch(1);
		CompletableFuture<Reply> first = CompletableFuture.supplyAsync(() -> transcribe(path));
		assertThat(fake.entered.await(10, TimeUnit.SECONDS)).isTrue();
		CompletableFuture<Reply> second = CompletableFuture.supplyAsync(() -> transcribe(path));
		Thread.sleep(200);
		fake.gate.countDown();
		assertThat(first.get(10, TimeUnit.SECONDS).ok(200).get("text").asString()).startsWith("Words of");
		assertThat(second.get(10, TimeUnit.SECONDS).ok(200).get("text").asString()).startsWith("Words of");
		assertThat(fake.calls).hasSize(1);
	}

	@Test
	void transcribingNeedsTheClientIdLikeEveryWrite() {
		String path = record("Recording 20261021180000.m4a", new byte[5]);
		assertThat(this.api.postJson("/api/transcriptions", Map.of("path", path), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		assertThat(fake.calls).isEmpty();
	}

}
