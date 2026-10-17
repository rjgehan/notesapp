package com.rjgehan.notes.watch;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.WatcherMode;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** The inotify watcher (DESIGN §5.9); the JDK watch service on Windows locks watched folders, hence Linux only. */
@EnabledOnOs(OS.LINUX)
class VaultWatcherTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private RescanScheduler rescans;

	private VaultWatcher watcher;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.vault.files.createText("A/B/x.md", "x", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.rescans = new RescanScheduler(this.vault.reconciler);
		this.rescans.start();
		this.watcher = new VaultWatcher(this.vault.fs, this.vault.reconciler, this.rescans, this.vault.hub, true,
				Duration.ofMillis(50));
		this.watcher.start();
		assertThat(this.watcher.mode()).isEqualTo(WatcherMode.INOTIFY);
	}

	@AfterEach
	void tearDown() {
		this.watcher.stop();
		this.rescans.stop();
		this.vault.close();
	}

	@Test
	void filesInANewSubdirectoryAreCaught() throws Exception {
		Files.createDirectories(this.dir.resolve("New/Inner"));
		Files.writeString(this.dir.resolve("New/Inner/x.md"), "x");
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("New/Inner/x.md") != null);
		Files.writeString(this.dir.resolve("New/Inner/later.md"), "later");
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("New/Inner/later.md") != null);
		assertThat(this.vault.index.isFolder("New/Inner")).isTrue();
	}

	@Test
	void externalEditsAndDeletesAreReconciled() throws Exception {
		Files.writeString(this.dir.resolve("A/B/x.md"), "edited outside");
		await().atMost(Duration.ofSeconds(10))
			.until(() -> this.vault.index.file("A/B/x.md").size() == "edited outside".length());
		Files.delete(this.dir.resolve("A/B/x.md"));
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("A/B/x.md") == null);
		assertThat(this.vault.hub.names()).contains("file.changed", "file.deleted");
	}

	@Test
	void aMovedFolderIsWatchedUnderItsNewPathOnly() throws Exception {
		Files.move(this.dir.resolve("A"), this.dir.resolve("C"));
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("C/B/x.md") != null);
		await().atMost(Duration.ofSeconds(10)).until(() -> !this.vault.index.isFolder("A"));
		Files.writeString(this.dir.resolve("C/B/y.md"), "y");
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("C/B/y.md") != null);
		assertThat(this.vault.index.file("A/B/y.md")).isNull();
		assertThat(this.vault.index.filesUnder("A")).isEmpty();
	}

	@Test
	void hiddenFoldersAreNotWatched() throws Exception {
		Files.createDirectories(this.dir.resolve(".private"));
		Files.writeString(this.dir.resolve(".private/secret.md"), "s");
		Files.writeString(this.dir.resolve("visible.md"), "v");
		await().atMost(Duration.ofSeconds(10)).until(() -> this.vault.index.file("visible.md") != null);
		assertThat(this.vault.index.isFolder(".private")).isFalse();
	}

	@Test
	void ignoredNamesNeverReachTheReconciler() {
		assertThat(VaultWatcher.isIgnored(".git/index")).isTrue();
		assertThat(VaultWatcher.isIgnored("Notes/.obsidian/workspace.json")).isTrue();
		assertThat(VaultWatcher.isIgnored("Notes/draft.md.swp")).isTrue();
		assertThat(VaultWatcher.isIgnored("Notes/Plan.md")).isFalse();
	}

}
