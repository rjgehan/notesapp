package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The status page's data (ROADMAP item 38) through the API: {@code GET /api/status/details} with a backup status file
 * and an {@code ntfy.json} that points at a local server standing in for ntfy, and a logged marker reaching it.
 */
@NotesIntegrationTest
class StatusDetailsIntegrationTest {

	@TempDir
	static Path vault;

	@TempDir
	static Path data;

	private static HttpServer ntfy;

	private static final List<JsonNode> received = new CopyOnWriteArrayList<>();

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		try {
			setUpFiles();
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		Path secrets = data.resolve("secrets");
		IntegrationProperties.register(registry, () -> vault,
				Map.of("notes.secrets-dir", secrets.toString(), "notes.backup.status-file",
						data.resolve("status.json").toString(), "notes.git.large-file-threshold", "1KB",
						"notes.welcome-note", "false", "notes.allowed-hosts", "localhost"));
	}

	/** The fake ntfy server, ntfy.json pointing at it, and a backup status from three hours ago. */
	private static void setUpFiles() throws IOException {
		ntfy = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		ntfy.createContext("/", (exchange) -> {
			received.add(Api.JSON.readTree(exchange.getRequestBody().readAllBytes()));
			exchange.sendResponseHeaders(200, -1);
			exchange.close();
		});
		ntfy.start();
		Path secrets = data.resolve("secrets");
		Files.createDirectories(secrets);
		Files.writeString(secrets.resolve("ntfy.json"), """
				{"server": "http://127.0.0.1:%d", "topic": "notes-test", "alerts": {"topic": "notes-ops"}}
				""".formatted(ntfy.getAddress().getPort()));
		Files.writeString(data.resolve("status.json"), """
				{"lastRun":"%s","result":"ok","snapshot":"4f1c2a9b","offsite":"off","lastSuccess":"%1$s","failures":null}
				""".formatted(Instant.now().minus(Duration.ofHours(3))));
	}

	@AfterAll
	static void stopNtfy() {
		ntfy.stop(0);
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
	void theDetailsDescribeTheRuntimeHistoryDiskBackupsAndAlerts() {
		this.api.postJson("/api/files", Map.of("path", "Counted.md", "content", "one")).ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Media/Big.bin"), new byte[4096]).ok(201);
		this.api.postEmpty("/api/history/commit").ok(200);

		JsonNode details = this.api.get("/api/status/details").ok(200);
		JsonNode runtime = details.get("runtime");
		assertThat(runtime.get("javaVersion").asString()).startsWith(String.valueOf(Runtime.version().feature()));
		assertThat(runtime.get("aotCache").asString()).isEqualTo("off");
		assertThat(runtime.get("heapMaxBytes").asLong()).isPositive();
		assertThat(details.get("events").get("clients").asInt()).isNotNegative();

		JsonNode git = details.get("git");
		assertThat(git.get("commits").asLong()).isGreaterThanOrEqualTo(1);
		assertThat(git.get("commitsThisRun").asLong()).isGreaterThanOrEqualTo(1);
		assertThat(git.get("failedCommitsThisRun").asLong()).isZero();
		assertThat(git.get("largeFiles")).singleElement().satisfies((file) -> {
			assertThat(file.get("path").asString()).isEqualTo("Media/Big.bin");
			assertThat(file.get("bytes").asLong()).isEqualTo(4096);
		});
		assertThat(git.get("largeFilesTruncated").asBoolean()).isFalse();
		assertThat(details.get("disk").get("totalBytes").asLong()).isPositive();

		JsonNode backup = details.get("backup");
		assertThat(backup.get("state").asString()).isEqualTo("ok");
		assertThat(backup.get("snapshot").asString()).isEqualTo("4f1c2a9b");
		assertThat(backup.get("offsite").asString()).isEqualTo("off");
		assertThat(backup.get("failures").isNull()).isTrue();

		JsonNode alerts = details.get("alerts");
		assertThat(alerts.get("state").asString()).isEqualTo("on");
		assertThat(alerts.get("server").asString()).isEqualTo("http://127.0.0.1:" + ntfy.getAddress().getPort());
		assertThat(alerts.toString()).doesNotContain("notes-test").doesNotContain("notes-ops");

		long before = git.get("commits").asLong();
		this.api.postJson("/api/files", Map.of("path", "Counted too.md", "content", "two")).ok(201);
		this.api.postEmpty("/api/history/commit").ok(200);
		assertThat(this.api.get("/api/status/details").ok(200).get("git").get("commits").asLong())
			.isEqualTo(before + 1);
	}

	@Test
	void aTestAlertIsSentAtOnceAndRefusedWhileAlertsAreOff() throws IOException {
		JsonNode result = this.api.postEmpty("/api/alerts/test").ok(200);
		assertThat(result.get("sent").asBoolean()).isTrue();
		assertThat(result.get("error").isNull()).isTrue();
		assertThat(received).anySatisfy((alert) -> {
			assertThat(alert.get("title").asString()).isEqualTo("NotesApp: test alert");
			assertThat(alert.get("topic").asString()).isEqualTo("notes-ops");
		});

		Path file = data.resolve("secrets").resolve("ntfy.json");
		Path aside = data.resolve("ntfy.json.aside");
		Files.move(file, aside);
		try {
			assertThat(this.api.postEmpty("/api/alerts/test").problem(400)).isEqualTo("bad-request");
			assertThat(this.api.get("/api/status/details").ok(200).get("alerts").get("state").asString())
				.isEqualTo("off");
		}
		finally {
			Files.move(aside, file);
		}
	}

	@Test
	void aLoggedMarkerReachesNtfyAndIsCounted() {
		LoggerFactory.getLogger(StatusDetailsIntegrationTest.class)
			.error("STORAGE_LOW only {} bytes are free (a test)", 12345);
		String title = "NotesApp: The vault's disk is almost full";
		await().atMost(Duration.ofSeconds(20))
			.until(() -> received.stream().anyMatch((alert) -> title.equals(alert.get("title").asString())));
		JsonNode alert = received.stream()
			.filter((sent) -> title.equals(sent.get("title").asString()))
			.findFirst()
			.orElseThrow();
		assertThat(alert.get("topic").asString()).isEqualTo("notes-ops");
		assertThat(alert.get("priority").asInt()).isEqualTo(4);
		assertThat(alert.get("click").asString()).isEqualTo("https://localhost/x/status");
		assertThat(alert.get("message").asString()).contains("STORAGE_LOW").doesNotContain("12345");

		await().atMost(Duration.ofSeconds(5))
			.until(() -> this.api.get("/api/status/details").ok(200).get("alerts").get("sent").asLong() >= 1);
		JsonNode alerts = this.api.get("/api/status/details").ok(200).get("alerts");
		assertThat(alerts.get("lastSentAt").isNull()).isFalse();
		assertThat(alerts.get("recent")).anySatisfy((count) -> {
			assertThat(count.get("marker").asString()).isEqualTo("STORAGE_LOW");
			assertThat(count.get("count").asLong()).isEqualTo(1);
		});
	}

}
