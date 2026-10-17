package com.rjgehan.notes.startup;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.Map;

import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.history.GitBootstrap;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** The startup sequence: settings, git, the first-run welcome rule and the bootstrap commit (DESIGN §5.17, §7.8). */
class VaultStartupTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private Path root() {
		return this.dir.resolve("vault");
	}

	private TestVault boot(Map<String, String> overrides) {
		if (this.vault != null) {
			this.vault.close();
		}
		this.vault = TestVault.create(root(), overrides);
		MockEnvironment environment = new MockEnvironment();
		environment.setActiveProfiles("dev");
		GitBootstrap bootstrap = new GitBootstrap(this.vault.git, this.vault.batcher, this.vault.hub,
				this.vault.properties);
		new VaultStartup(this.vault.properties, environment, this.vault.fs,
				new TailscaleInterfaceCheck(this.vault.properties), this.vault.settings, this.vault.git,
				new WelcomeContent(), this.vault.builder, bootstrap)
			.afterSingletonsInstantiated();
		bootstrap.onReady();
		await().atMost(Duration.ofSeconds(20)).until(() -> !this.vault.batcher.isImporting());
		return this.vault;
	}

	private TestVault boot() {
		return boot(Map.of());
	}

	private String lastMessage(String path) throws Exception {
		return this.vault.history.list(path, 1, 0).entries().get(0).message();
	}

	@AfterEach
	void tearDown() {
		if (this.vault != null) {
			this.vault.close();
		}
	}

	@Test
	void aFreshVaultGetsTheWelcomeNoteAndAnInitialCommit() throws Exception {
		boot();
		assertThat(root().resolve("Welcome.md")).exists();
		assertThat(this.vault.index.file("Welcome.md")).isNotNull();
		assertThat(this.vault.index.note("Welcome.md").parse().headings().get(0).text())
			.isEqualTo("Welcome to NotesApp");
		assertThat(root().resolve(".notesapp/settings.json")).exists();
		assertThat(lastMessage("Welcome.md")).isEqualTo("Initial commit");
		assertThat(this.vault.git.diskPathAtHead(".notesapp/settings.json")).isNotNull();
	}

	@Test
	void aPrePopulatedVaultIsImportedWithoutAWelcomeNote() throws Exception {
		Files.createDirectories(root().resolve("Notes"));
		Files.writeString(root().resolve("Notes/a.md"), "a");
		boot();
		assertThat(root().resolve("Welcome.md")).doesNotExist();
		HistoryEntry entry = this.vault.history.list("Notes/a.md", 1, 0).entries().get(0);
		assertThat(entry.message()).startsWith("Import existing vault (");
		assertThat(entry.authorName()).isEqualTo("NotesApp");
	}

	@Test
	void aVaultWhoseFilesWereAllDeletedGetsNoWelcomeNote() throws Exception {
		boot();
		Files.delete(root().resolve("Welcome.md"));
		boot();
		assertThat(root().resolve("Welcome.md")).doesNotExist();
		assertThat(this.vault.index.stats().files()).isZero();
	}

	@Test
	void aTreeChangedWhileStoppedGetsTheExternalCommit() throws Exception {
		boot();
		Files.writeString(root().resolve("Later.md"), "written while the app was down");
		boot();
		HistoryEntry entry = this.vault.history.list("Later.md", 1, 0).entries().get(0);
		assertThat(entry.message()).isEqualTo("Changes made while NotesApp was stopped");
		assertThat(entry.authorName()).isEqualTo("External");
	}

	@Test
	void theWelcomeNoteCanBeTurnedOff() {
		boot(Map.of("notes.welcome-note", "false"));
		assertThat(root().resolve("Welcome.md")).doesNotExist();
	}

	@Test
	void withoutGitAnEmptyFolderDecidesWhatAFirstRunIs() throws Exception {
		Map<String, String> noGit = new HashMap<>();
		noGit.put("notes.git.enabled", "false");
		boot(noGit);
		assertThat(root().resolve("Welcome.md")).exists();
		Files.delete(root().resolve("Welcome.md"));
		boot(noGit);
		assertThat(root().resolve("Welcome.md")).doesNotExist();
	}

}
