package com.rjgehan.notes.history;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.VaultFs;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

class GitStoreTest {

	@TempDir
	Path vault;

	private GitStore store(Map<String, String> overrides) {
		var properties = TestProperties.forVault(this.vault, overrides);
		return new GitStore(new VaultFs(properties), properties, Clock.systemUTC());
	}

	private static GitStore.Commit commitFile(GitStore git, Path vault, String name, String content) throws Exception {
		Files.writeString(vault.resolve(name), content);
		return git.commit(List.of(ApiPath.of(name)), List.of(), (changes) -> new GitStore.Message("Update " + name,
				null), Author.EXTERNAL);
	}

	@Test
	void initializesOnMainWithTheAppConfiguration() throws Exception {
		GitStore git = store(Map.of());
		git.openOrInit();
		try {
			assertThat(git.createdThisBoot()).isTrue();
			assertThat(git.isEnabled()).isTrue();
			var config = git.repository().getConfig();
			assertThat(git.repository().getBranch()).isEqualTo("main");
			assertThat(config.getString("core", null, "hooksPath")).isEqualTo(".git/notesapp-no-hooks");
			assertThat(config.getBoolean("core", null, "autocrlf", true)).isFalse();
			assertThat(config.getBoolean("gc", null, "autoDetach", true)).isFalse();
			assertThat(config.getBoolean("diff", null, "renames", false)).isTrue();
			assertThat(config.getInt("diff", null, "renameLimit", 0)).isEqualTo(10000);
			assertThat(Files.isDirectory(this.vault.resolve(".git/notesapp-no-hooks"))).isTrue();
			assertThat(Files.readString(this.vault.resolve(".git/info/exclude"))).contains(".trash/")
				.contains(".notesapp/tmp/");
		}
		finally {
			git.close();
		}
	}

	@Test
	void staleLocksAreRemovedAndCommitsWork() throws Exception {
		GitStore first = store(Map.of());
		first.openOrInit();
		commitFile(first, this.vault, "a.md", "a");
		first.close();
		Files.writeString(this.vault.resolve(".git/index.lock"), "");
		Files.createDirectories(this.vault.resolve(".git/refs/heads"));
		Files.writeString(this.vault.resolve(".git/refs/heads/main.lock"), "");

		GitStore second = store(Map.of());
		second.openOrInit();
		try {
			assertThat(second.createdThisBoot()).isFalse();
			assertThat(Files.exists(this.vault.resolve(".git/index.lock"))).isFalse();
			assertThat(Files.exists(this.vault.resolve(".git/refs/heads/main.lock"))).isFalse();
			assertThat(commitFile(second, this.vault, "b.md", "b")).isNotNull();
			assertThat(second.hasCommits()).isTrue();
		}
		finally {
			second.close();
		}
	}

	@Test
	void lfsRepositoriesDisableHistory() throws Exception {
		try (Git git = Git.init().setDirectory(this.vault.toFile()).setInitialBranch("main").call()) {
			var config = git.getRepository().getConfig();
			config.setString("filter", "lfs", "clean", "git-lfs clean -- %f");
			config.save();
		}
		GitStore store = store(Map.of());
		store.openOrInit();
		try {
			assertThat(store.isEnabled()).isFalse();
			assertThat(store.isDisabledByConfiguration()).isFalse();
			assertThat(store.disabledReason()).isEqualTo("git-lfs is not supported");
		}
		finally {
			store.close();
		}
	}

	@Test
	void lfsAttributesAlsoDisableHistory() throws Exception {
		Files.writeString(this.vault.resolve(".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
		GitStore store = store(Map.of());
		store.openOrInit();
		try {
			assertThat(store.isEnabled()).isFalse();
		}
		finally {
			store.close();
		}
	}

	@Test
	void historyCanBeDisabledByConfiguration() throws Exception {
		GitStore store = store(Map.of("notes.git.enabled", "false"));
		store.openOrInit();
		assertThat(store.isEnabled()).isFalse();
		assertThat(store.isDisabledByConfiguration()).isTrue();
		assertThat(store.disabledReason()).isEqualTo("disabled by configuration");
		assertThat(Files.exists(this.vault.resolve(".git"))).isFalse();
		store.close();
	}

	@Test
	void commitAllStagesAdditionsAndDeletions() throws Exception {
		GitStore git = store(Map.of());
		git.openOrInit();
		try {
			Files.writeString(this.vault.resolve("one.md"), "1");
			Files.writeString(this.vault.resolve("two.md"), "2");
			GitStore.Commit initial = git.commitAll((changes) -> new GitStore.Message("Import existing vault ("
					+ changes.size() + " files)", null), Author.EXTERNAL);
			assertThat(initial.subject()).isEqualTo("Import existing vault (2 files)");
			assertThat(git.isDirty()).isFalse();
			Files.delete(this.vault.resolve("one.md"));
			assertThat(git.isDirty()).isTrue();
			GitStore.Commit removal = git.commitAll((changes) -> new GitStore.Message("x", null), Author.EXTERNAL);
			assertThat(removal.paths()).containsExactly("one.md");
			assertThat(git.commitAll((changes) -> new GitStore.Message("x", null), Author.EXTERNAL)).isNull();
		}
		finally {
			git.close();
		}
	}

}
