package com.rjgehan.notes.api;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.RawHttp;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.VaultFs;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * Attachments and raw uploads (DESIGN §8.1 integration items 4 and 15): the folder from the settings,
 * de-duplication, link text, the size cap, insufficient storage, idempotent retries, and a slow upload that never
 * delays saves. Uploads are capped at 64 KiB here, and free space is simulated.
 */
@NotesIntegrationTest
class UploadIntegrationTest {

	private static final long UPLOAD_CAP = 64 * 1024;

	private static final long MIN_FREE = 1024L * 1024 * 1024;

	/** The free space the server sees; negative means the real value. */
	static final AtomicLong simulatedFreeSpace = new AtomicLong(-1);

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.limits.max-upload-size", "64KB"));
	}

	@TestBean
	VaultFs vaultFs;

	static VaultFs vaultFs() {
		return new VaultFs(TestProperties.forVault(vault)) {

			@Override
			public long usableSpace() throws IOException {
				long simulated = simulatedFreeSpace.get();
				return (simulated >= 0) ? simulated : super.usableSpace();
			}

		};
	}

	@LocalServerPort
	int port;

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
	void realFreeSpace() {
		simulatedFreeSpace.set(-1);
	}

	private Reply attach(String name, String source, byte[] bytes, String... headers) {
		String uri = "/api/attachments?name=" + Api.enc(name) + ((source != null) ? "&source=" + Api.enc(source) : "");
		return this.api.postBytes(uri, bytes, headers);
	}

	private void updateSettings(Consumer<ObjectNode> change) {
		JsonNode current = this.api.get("/api/settings").ok(200);
		ObjectNode settings = (ObjectNode) current.get("settings").deepCopy();
		change.accept((ObjectNode) settings.get("files"));
		this.api.putJson("/api/settings", Map.of("settings", settings, "baseVersion", current.get("version").asString()))
			.ok(200);
	}

	// ---------------------------------------------------------------- item 4: attachments

	@Test
	void theFolderFollowsTheSettings() {
		byte[] png = { (byte) 0x89, 'P', 'N', 'G' };
		JsonNode first = attach("Pasted image 20261016140322.png", "Daily/2026-10-16.md", png).ok(201);
		assertThat(first.get("file").get("path").asString()).isEqualTo("Attachments/Pasted image 20261016140322.png");
		assertThat(first.get("file").get("kind").asString()).isEqualTo("image");
		assertThat(first.get("created").asBoolean()).isTrue();
		assertThat(first.get("createdFolders").values().stream().map(JsonNode::asString)).containsExactly("Attachments");
		assertThat(first.get("linkText").asString()).isEqualTo("Pasted image 20261016140322.png");
		assertThat(first.get("markdown").asString()).isEqualTo("![[Pasted image 20261016140322.png]]");

		try {
			updateSettings((files) -> files.put("attachmentLocation", "subfolder"));
			JsonNode subfolder = attach("s.png", "Daily/2026-10-16.md", png).ok(201);
			assertThat(subfolder.get("file").get("path").asString()).isEqualTo("Daily/attachments/s.png");
			assertThat(subfolder.get("createdFolders").values().stream().map(JsonNode::asString))
				.containsExactly("Daily", "Daily/attachments");

			updateSettings((files) -> files.put("attachmentLocation", "current"));
			assertThat(attach("c.png", "Daily/2026-10-16.md", png).ok(201).get("file").get("path").asString())
				.isEqualTo("Daily/c.png");
			assertThat(attach("noSource.png", null, png).ok(201).get("file").get("path").asString())
				.isEqualTo("noSource.png");

			updateSettings((files) -> files.put("attachmentLocation", "root"));
			assertThat(attach("r.png", "Daily/2026-10-16.md", png).ok(201).get("file").get("path").asString())
				.isEqualTo("r.png");

			this.api.postJson("/api/folders", Map.of("path", "media")).ok(201);
			updateSettings((files) -> {
				files.put("attachmentLocation", "folder");
				files.put("attachmentFolder", "Media");
			});
			JsonNode reused = attach("m.png", null, png).ok(201);
			assertThat(reused.get("file").get("path").asString()).isEqualTo("media/m.png");
			assertThat(reused.get("createdFolders").isEmpty()).isTrue();
		}
		finally {
			updateSettings((files) -> {
				files.put("attachmentLocation", "folder");
				files.put("attachmentFolder", "Attachments");
			});
		}
	}

	@Test
	void namesAreSanitizedAndDeduplicatedCaseInsensitively() {
		byte[] bytes = { 1, 2, 3 };
		Map<String, String> vectors = Map.of("a/b.png", "b.png", "../x.png", "x.png", ".env", "env", "con.png",
				"_con.png", "x.tmp", "x.tmp.file", "notes .", "notes", "a:b?.png", "a-b-.png", ".png", "attachment.png");
		vectors.forEach((name, expected) -> assertThat(
				attach(name, null, bytes).ok(201).get("file").get("path").asString())
			.as(name)
			.isEqualTo("Attachments/" + expected));
		assertThat(attach("dup.png", null, bytes).ok(201).get("file").get("path").asString())
			.isEqualTo("Attachments/dup.png");
		assertThat(attach("DUP.png", null, bytes).ok(201).get("file").get("path").asString())
			.isEqualTo("Attachments/DUP 1.png");
		assertThat(attach("dup.png", null, bytes).ok(201).get("file").get("path").asString())
			.isEqualTo("Attachments/dup 2.png");
		assertThat(this.api.postBytes("/api/attachments", bytes).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.postBytes("/api/attachments?name=", bytes).problem(400)).isEqualTo("bad-request");
	}

	@Test
	void linkTextFollowsTheLinkSettings() {
		byte[] bytes = { 4, 5, 6 };
		attach("shared name.png", null, bytes).ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Other/shared name 1.png"), bytes).ok(201);
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Other/Shared Name.png"), bytes).ok(201);
		JsonNode ambiguous = attach("shared name.png", null, bytes).ok(201);
		assertThat(ambiguous.get("file").get("path").asString()).isEqualTo("Attachments/shared name 1.png");
		assertThat(ambiguous.get("linkText").asString()).isEqualTo("Attachments/shared name 1.png");
		try {
			updateSettings((files) -> files.put("useWikilinks", false));
			JsonNode markdown = attach("Pasted image 1.png", "Notes/a.md", bytes).ok(201);
			assertThat(markdown.get("linkText").asString()).isEqualTo("Pasted image 1.png");
			assertThat(markdown.get("markdown").asString()).isEqualTo("![](Pasted%20image%201.png)");
			updateSettings((files) -> files.put("newLinkFormat", "relative"));
			JsonNode relative = attach("rel (1).png", "Notes/a.md", bytes).ok(201);
			assertThat(relative.get("linkText").asString()).isEqualTo("../Attachments/rel (1).png");
			assertThat(relative.get("markdown").asString()).isEqualTo("![](../Attachments/rel%20%281%29.png)");
		}
		finally {
			updateSettings((files) -> {
				files.put("useWikilinks", true);
				files.put("newLinkFormat", "shortest");
			});
		}
	}

	@Test
	void anIdempotencyKeyRetryReturnsTheFirstResult() {
		byte[] png = { 7, 7, 7 };
		Reply first = attach("retry.png", null, png, "Idempotency-Key", "attach-key-0001");
		assertThat(first.ok(201).get("file").get("path").asString()).isEqualTo("Attachments/retry.png");
		Reply retried = attach("retry.png", null, png, "Idempotency-Key", "attach-key-0001");
		assertThat(retried.status()).isEqualTo(201);
		assertThat(retried.json()).isEqualTo(first.json());
		assertThat(Files.exists(vault.resolve("Attachments/retry 1.png"))).isFalse();
		assertThat(attach("retry.png", null, png, "Idempotency-Key", "attach-key-0002").ok(201).get("file").get("path")
			.asString()).isEqualTo("Attachments/retry 1.png");
	}

	@Test
	void uploadsOverTheCapAreRejected() throws IOException {
		byte[] tooLarge = new byte[(int) UPLOAD_CAP + 1];
		Reply attachment = attach("big.png", null, tooLarge);
		assertThat(attachment.problem(413)).isEqualTo("too-large");
		assertThat(attachment.json().get("limit").asLong()).isEqualTo(UPLOAD_CAP);
		Reply raw = this.api.putBytes("/api/files/raw?path=big.bin", tooLarge);
		assertThat(raw.problem(413)).isEqualTo("too-large");
		assertThat(attach("fits.png", null, new byte[(int) UPLOAD_CAP]).status()).isEqualTo(201);

		// A chunked body announces no length: it is cut off once it passes the cap.
		try (RawHttp http = new RawHttp(this.port, Duration.ofSeconds(10))) {
			http.sendHead("""
					POST /api/attachments?name=chunked.png HTTP/1.1
					Host: localhost:%d
					X-Client-Id: %s
					Content-Type: image/png
					Transfer-Encoding: chunked
					Connection: close
					""".formatted(this.port, Api.CLIENT_ID));
			byte[] chunk = new byte[8192];
			for (int i = 0; i < 9; i++) {
				http.sendBody((Integer.toHexString(chunk.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
				http.sendBody(chunk);
				http.sendBody("\r\n".getBytes(StandardCharsets.US_ASCII));
			}
			http.sendBody("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
			RawHttp.Response response = http.readResponse();
			assertThat(response.status()).isEqualTo(413);
			assertThat(Api.JSON.readTree(response.body()).get("limit").asLong()).isEqualTo(UPLOAD_CAP);
		}
		assertThat(Files.exists(vault.resolve("Attachments/big.png"))).isFalse();
		assertThat(Files.exists(vault.resolve("Attachments/chunked.png"))).isFalse();
		try (var temp = Files.list(vault.resolve(".notesapp/tmp"))) {
			assertThat(temp).isEmpty();
		}
	}

	/** One request with a body on a fresh connection. */
	private RawHttp.Response send(String requestLine, String contentType, byte[] body) throws IOException {
		try (RawHttp http = new RawHttp(this.port, Duration.ofSeconds(10))) {
			http.sendHead("""
					%s HTTP/1.1
					Host: localhost:%d
					X-Client-Id: %s
					Content-Type: %s
					Content-Length: %d
					Connection: close
					""".formatted(requestLine, this.port, Api.CLIENT_ID, contentType, body.length));
			http.sendBody(body);
			return http.readResponse();
		}
	}

	@Test
	void formEncodedContentTypesAreUploadedAsRawBytes() throws IOException {
		// curl --data-binary sends application/x-www-form-urlencoded unless told otherwise.
		String form = "application/x-www-form-urlencoded";
		byte[] body = "hello=world&x=1".getBytes(StandardCharsets.US_ASCII);
		RawHttp.Response put = send("PUT /api/files/raw?path=Form/put.png", form, body);
		assertThat(put.status()).as(put.body()).isEqualTo(201);
		assertThat(Files.readAllBytes(vault.resolve("Form/put.png"))).isEqualTo(body);

		RawHttp.Response attachment = send("POST /api/attachments?name=form.png", form, body);
		assertThat(attachment.status()).as(attachment.body()).isEqualTo(201);
		assertThat(Files.readAllBytes(vault.resolve("Attachments/form.png"))).isEqualTo(body);

		byte[] replacement = "a=b".getBytes(StandardCharsets.US_ASCII);
		RawHttp.Response overwrite = send("PUT /api/files/raw?path=Form/put.png&onConflict=overwrite",
				form + "; charset=UTF-8", replacement);
		assertThat(overwrite.status()).as(overwrite.body()).isEqualTo(200);
		assertThat(Files.readAllBytes(vault.resolve("Form/put.png"))).isEqualTo(replacement);

		// A chunked form-encoded body is counted against the upload cap like any other, never parsed as a form.
		try (RawHttp http = new RawHttp(this.port, Duration.ofSeconds(10))) {
			http.sendHead("""
					PUT /api/files/raw?path=Form/big.png HTTP/1.1
					Host: localhost:%d
					X-Client-Id: %s
					Content-Type: %s
					Transfer-Encoding: chunked
					Connection: close
					""".formatted(this.port, Api.CLIENT_ID, form));
			byte[] chunk = "a=".repeat(4096).getBytes(StandardCharsets.US_ASCII);
			for (int i = 0; i < 9; i++) {
				http.sendBody((Integer.toHexString(chunk.length) + "\r\n").getBytes(StandardCharsets.US_ASCII));
				http.sendBody(chunk);
				http.sendBody("\r\n".getBytes(StandardCharsets.US_ASCII));
			}
			http.sendBody("0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
			RawHttp.Response tooLarge = http.readResponse();
			assertThat(tooLarge.status()).as(tooLarge.body()).isEqualTo(413);
		}
		assertThat(Files.exists(vault.resolve("Form/big.png"))).isFalse();
	}

	@Test
	void uploadsThatWouldLeaveTooLittleFreeSpaceAreRejected() {
		simulatedFreeSpace.set(MIN_FREE + 2);
		Reply attachment = attach("space.png", null, new byte[] { 1, 2, 3 });
		assertThat(attachment.problem(507)).isEqualTo("insufficient-storage");
		assertThat(attachment.json().get("title").asString()).isEqualTo("Insufficient storage");
		assertThat(attachment.json().get("limit").asLong()).isEqualTo(MIN_FREE);
		assertThat(this.api.putBytes("/api/files/raw?path=space.bin", new byte[] { 1, 2, 3 }).problem(507))
			.isEqualTo("insufficient-storage");
		assertThat(Files.exists(vault.resolve("Attachments/space.png"))).isFalse();
		simulatedFreeSpace.set(MIN_FREE + 1024);
		assertThat(attach("space.png", null, new byte[] { 1, 2, 3 }).status()).isEqualTo(201);
	}

	@Test
	void otherClientsAreToldAboutNewFoldersAndFiles() {
		try (SseRecorder mine = SseRecorder.open(this.port, Api.CLIENT_ID, null);
				SseRecorder theirs = SseRecorder.open(this.port, "other-client-01", null)) {
			JsonNode result = attach("e.png", "Events/n.md", new byte[] { 1 }).ok(201);
			assertThat(result.get("file").get("path").asString()).isEqualTo("Attachments/e.png");
			List<String> events = theirs.awaitEvent("file.created");
			assertThat(events).containsSubsequence("file.created");
			JsonNode created = theirs.frames()
				.stream()
				.filter((frame) -> frame.event().equals("file.created"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(created.get("file")).isEqualTo(result.get("file"));
			assertThat(created.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			assertThat(created.size()).as("FileEvent has exactly file and origin").isEqualTo(2);
			assertThat(mine.eventNames()).doesNotContain("file.created", "folder.created");
		}
	}

	// ---------------------------------------------------------------- item 15: a slow upload never delays saves

	@Test
	void aSlowUploadDoesNotDelaySaves() throws Exception {
		JsonNode note = this.api.postJson("/api/files", Map.of("path", "Slow/Note.md", "content", "0")).ok(201);
		String version = note.get("file").get("version").asString();
		List<Long> baseline = new ArrayList<>();
		for (int i = 1; i <= 10; i++) {
			long start = System.nanoTime();
			version = this.api.putJson("/api/files?path=" + Api.enc("Slow/Note.md"),
					Map.of("content", "b" + i, "baseVersion", version)).ok(200).get("file").get("version").asString();
			baseline.add(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
		}

		int length = 50;
		// The trickle runs on its own thread, not the common pool: on a 2-CPU runner that pool has one worker, and on
		// JDK 25 the HTTP client sending the saves below needs it, so 5 s of sleeps there would hold every save back.
		Executor ownThread = (task) -> Thread.ofPlatform().daemon().name("slow-upload").start(task);
		CompletableFuture<RawHttp.Response> upload = CompletableFuture.supplyAsync(() -> {
			try (RawHttp http = new RawHttp(this.port, Duration.ofSeconds(30))) {
				http.sendHead("""
						PUT /api/files/raw?path=Slow/video.mp4 HTTP/1.1
						Host: localhost:%d
						X-Client-Id: slow-client-01
						Content-Type: video/mp4
						Content-Length: %d
						Connection: close
						""".formatted(this.port, length));
				for (int i = 0; i < length; i++) {
					http.sendBody(new byte[] { (byte) i });
					Thread.sleep(100);
				}
				return http.readResponse();
			}
			catch (IOException ex) {
				throw new IllegalStateException(ex);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				throw new IllegalStateException(ex);
			}
		}, ownThread);

		List<Long> during = new ArrayList<>();
		Thread.sleep(300);
		for (int i = 1; !upload.isDone(); i++) {
			long start = System.nanoTime();
			version = this.api.putJson("/api/files?path=" + Api.enc("Slow/Note.md"),
					Map.of("content", "d" + i, "baseVersion", version)).ok(200).get("file").get("version").asString();
			during.add(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
			Thread.sleep(100);
		}
		RawHttp.Response response = upload.get(30, TimeUnit.SECONDS);
		assertThat(response.status()).as(response.body()).isEqualTo(201);
		assertThat(Files.size(vault.resolve("Slow/video.mp4"))).isEqualTo(length);
		assertThat(during).hasSizeGreaterThan(10);
		// Blocked behind the upload, a save would wait for its whole body (5 s) or fail with 503 busy.
		long slowest = during.stream().mapToLong(Long::longValue).max().orElseThrow();
		assertThat(slowest).as("save times during the upload %s (baseline %s)", during, baseline).isLessThan(1000);
		assertThat(median(during)).as("median save time during the upload, baseline %s", baseline)
			.isLessThanOrEqualTo(median(baseline) + 50);
	}

	private static long median(List<Long> values) {
		List<Long> sorted = values.stream().sorted().toList();
		return sorted.get(sorted.size() / 2);
	}

}
