package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.jspecify.annotations.Nullable;
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
 * The git mirror (ROADMAP item 2) and the large-file policy (item 23) through the API: {@code /api/status},
 * {@code POST /api/mirror/push} with a local bare repository as the mirror, and the history of a large file.
 */
@NotesIntegrationTest
class MirrorAndLargeFilesIntegrationTest {

	@TempDir
	static Path vault;

	@TempDir
	static Path remotes;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		Path bare = remotes.resolve("mirror.git");
		try {
			Git.init().setBare(true).setDirectory(bare.toFile()).setInitialBranch("main").call().close();
		}
		catch (GitAPIException ex) {
			throw new IllegalStateException(ex);
		}
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.git.large-file-threshold", "1KB",
				"notes.limits.max-text-size", "1KB", "notes.welcome-note", "false",
				"notes.mirror.url", bare.toUri().toString()));
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

	private static @Nullable String mirrorHead() throws Exception {
		try (Repository remote = new FileRepositoryBuilder().setGitDir(remotes.resolve("mirror.git").toFile())
			.build()) {
			ObjectId id = remote.resolve("refs/heads/main");
			return (id != null) ? id.name() : null;
		}
	}

	@Test
	void aLargeUploadIsCountedInTheStatusAndItsHistorySaysWhy() {
		byte[] big = new byte[2048];
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Attachments/Big video.bin"), big).ok(201);
		JsonNode largeFiles = this.api.get("/api/status").ok(200).get("git").get("largeFiles");
		assertThat(largeFiles.get("limitBytes").asLong()).isEqualTo(1024);
		assertThat(largeFiles.get("files").asInt()).isEqualTo(1);
		assertThat(largeFiles.get("bytes").asLong()).isEqualTo(2048);

		this.api.postEmpty("/api/history/commit").ok(200);
		JsonNode history = this.api.get("/api/history?path=" + Api.enc("Attachments/Big video.bin")).ok(200);
		assertThat(history.get("pending").asBoolean()).isFalse();
		assertThat(history.get("entries").isEmpty()).isTrue();
		JsonNode excluded = history.get("excluded");
		assertThat(excluded.get("reason").asString()).isEqualTo("large-file");
		assertThat(excluded.get("size").asLong()).isEqualTo(2048);
		assertThat(excluded.get("limitBytes").asLong()).isEqualTo(1024);

		JsonNode note = this.api.get("/api/history?path=Nothing.md").ok(200);
		assertThat(note.has("excluded")).isTrue();
		assertThat(note.get("excluded").isNull()).isTrue();
	}

	@Test
	void aRequestedPushMirrorsTheHistory() throws Exception {
		this.api.postJson("/api/files", Map.of("path", "Mirrored.md", "content", "hello")).ok(201);
		this.api.postEmpty("/api/history/commit").ok(200);
		JsonNode mirror = this.api.get("/api/status").ok(200).get("mirror");
		assertThat(mirror.get("state").asString()).isEqualTo("ready");
		assertThat(mirror.get("remote").asString()).startsWith("file:");
		assertThat(mirror.get("branch").asString()).isEqualTo("main");
		assertThat(mirror.has("lastError")).isTrue();

		JsonNode accepted = this.api.postEmpty("/api/mirror/push").ok(202);
		assertThat(accepted.get("state").asString()).isEqualTo("ready");
		String head = this.api.get("/api/status").ok(200).get("git").get("head").asString();
		await().atMost(Duration.ofSeconds(30)).until(() -> head.equals(mirrorHead()));
		await().atMost(Duration.ofSeconds(10))
			.until(() -> head.equals(this.api.get("/api/status").ok(200).get("mirror").get("pushedCommit").asString()));
		assertThat(Files.isDirectory(remotes.resolve("mirror.git"))).isTrue();
	}

	@Test
	void pushingNeedsTheClientHeaderLikeEveryMutation() {
		assertThat(this.api.postEmpty("/api/mirror/push", "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
	}

}
