package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.UncheckedIOException;
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
import org.eclipse.jgit.lib.PersonIdent;
import org.eclipse.jgit.lib.StoredConfig;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
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
 * Importing a vault that is already a git repository with hooks (DESIGN §8.1 integration item 14): the app's commits
 * never run them. The {@code pre-commit} hook would also make every commit fail if it ran.
 */
@NotesIntegrationTest
class GitHooksIntegrationTest {

	@TempDir
	static Path vault;

	@TempDir
	static Path outside;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		prepareRepositoryWithHooks();
		IntegrationProperties.register(registry, () -> vault);
	}

	/** Runs before the application starts: a repository with one commit, an uncommitted note and active hooks. */
	static void prepareRepositoryWithHooks() {
		try (Git git = Git.init().setDirectory(vault.toFile()).setInitialBranch("main").call()) {
			Files.writeString(vault.resolve("Seed.md"), "seed\n");
			git.add().addFilepattern("Seed.md").call();
			PersonIdent someone = new PersonIdent("Someone", "someone@example.com");
			git.commit().setMessage("Seed").setAuthor(someone).setCommitter(someone).call();
			Files.writeString(vault.resolve("Uncommitted.md"), "added before NotesApp\n");
			Path hooks = vault.resolve(".git/hooks");
			Files.createDirectories(hooks);
			String marker = marker().toAbsolutePath().toString().replace('\\', '/');
			hook(hooks.resolve("post-commit"), "echo ran > '" + marker + "'");
			hook(hooks.resolve("pre-commit"), "echo ran > '" + marker + "'\nexit 1");
			hook(hooks.resolve("commit-msg"), "echo ran > '" + marker + "'\nexit 1");
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		catch (GitAPIException ex) {
			throw new IllegalStateException(ex);
		}
	}

	private static void hook(Path file, String body) throws IOException {
		Files.writeString(file, "#!/bin/sh\n" + body + "\n");
		file.toFile().setExecutable(true);
	}

	private static Path marker() {
		return outside.resolve("hook-ran");
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
	void hooksNeverRunForTheAppsCommits() throws IOException {
		JsonNode imported = this.api.get("/api/history?path=Uncommitted.md").ok(200).get("entries").get(0);
		assertThat(imported.get("message").asString()).isEqualTo("Changes made while NotesApp was stopped");
		assertThat(this.api.get("/api/history?path=Seed.md").ok(200).get("entries").get(0).get("message").asString())
			.isEqualTo("Seed");

		String version = this.api.postJson("/api/files", Map.of("path", "Hooked.md", "content", "1"))
			.ok(201)
			.get("file")
			.get("version")
			.asString();
		assertThat(this.api.postEmpty("/api/history/commit").ok(200).get("commitId").isNull()).isFalse();
		this.api.putJson("/api/files?path=Hooked.md", Map.of("content", "2", "baseVersion", version)).ok(200);
		assertThat(this.api.postEmpty("/api/history/commit").ok(200).get("commitId").isNull()).isFalse();
		JsonNode moved = this.api.postJson("/api/move", Map.of("from", "Hooked.md", "to", "Moved.md")).ok(200);
		assertThat(moved.get("commitId").isNull()).isFalse();
		this.api.delete("/api/files?path=Seed.md").ok(200);

		assertThat(this.api.get("/api/history?path=Moved.md").ok(200).get("entries").size()).isEqualTo(3);
		JsonNode git = this.api.get("/api/status").ok(200).get("git");
		assertThat(git.get("state").asString()).isEqualTo("ready");
		assertThat(git.get("lastError").isNull()).isTrue();
		assertThat(marker()).doesNotExist();

		try (var repository = new FileRepositoryBuilder().setGitDir(vault.resolve(".git").toFile()).build()) {
			StoredConfig config = repository.getConfig();
			String hooksPath = config.getString("core", null, "hooksPath");
			assertThat(hooksPath).isNotBlank();
			Path hooks = vault.resolve(hooksPath);
			assertThat(hooks.normalize()).isNotEqualTo(vault.resolve(".git/hooks").normalize());
			if (Files.isDirectory(hooks)) {
				try (var entries = Files.list(hooks)) {
					assertThat(entries).isEmpty();
				}
			}
		}
	}

}
