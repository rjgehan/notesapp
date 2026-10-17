package com.rjgehan.notes.history;

import java.nio.file.Files;
import java.nio.file.Path;

import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.support.TestVault;
import org.eclipse.jgit.revwalk.RevCommit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

class GitBootstrapTest {

	@TempDir
	Path dir;

	private static GitBootstrap bootstrap(TestVault vault) {
		return new GitBootstrap(vault.git, vault.batcher, vault.hub, vault.properties);
	}

	private static RevCommit head(TestVault vault) throws Exception {
		GitStore git = vault.git;
		try (var walk = new org.eclipse.jgit.revwalk.RevWalk(git.repository())) {
			return walk.parseCommit(git.repository().resolve("HEAD"));
		}
	}

	private static void run(TestVault vault, boolean fresh) {
		GitBootstrap bootstrap = bootstrap(vault);
		bootstrap.setFreshVault(fresh);
		vault.batcher.beginImport();
		bootstrap.run();
	}

	@Test
	void aFreshVaultGetsTheInitialCommit() throws Exception {
		try (TestVault vault = TestVault.start(this.dir)) {
			Files.writeString(this.dir.resolve("Welcome.md"), "hi");
			run(vault, true);
			RevCommit head = head(vault);
			assertThat(head.getShortMessage()).isEqualTo("Initial commit");
			assertThat(head.getAuthorIdent().getName()).isEqualTo("NotesApp");
			assertThat(vault.batcher.isImporting()).isFalse();
			assertThat(vault.hub.published).last().isInstanceOf(StatusChangedEvent.class);
			assertThat(vault.hub.names()).contains("history.committed");
		}
	}

	@Test
	void anExistingFolderOfNotesIsImported() throws Exception {
		Files.writeString(this.dir.resolve("a.md"), "a");
		Files.createDirectories(this.dir.resolve("Sub"));
		Files.writeString(this.dir.resolve("Sub/b.md"), "b");
		try (TestVault vault = TestVault.start(this.dir)) {
			run(vault, false);
			assertThat(head(vault).getShortMessage()).isEqualTo("Import existing vault (2 files)");
		}
	}

	@Test
	void changesMadeWhileStoppedAreCommittedAsExternal() throws Exception {
		try (TestVault vault = TestVault.start(this.dir)) {
			Files.writeString(this.dir.resolve("a.md"), "a");
			run(vault, false);
		}
		Files.writeString(this.dir.resolve("a.md"), "edited while stopped");
		try (TestVault vault = TestVault.start(this.dir)) {
			run(vault, false);
			RevCommit head = head(vault);
			assertThat(head.getShortMessage()).isEqualTo("Changes made while NotesApp was stopped");
			assertThat(head.getAuthorIdent().getName()).isEqualTo("External");
		}
	}

	@Test
	void aCleanRepositoryGetsNoCommit() throws Exception {
		try (TestVault vault = TestVault.start(this.dir)) {
			Files.writeString(this.dir.resolve("a.md"), "a");
			run(vault, false);
			String head = vault.git.head();
			run(vault, false);
			assertThat(vault.git.head()).isEqualTo(head);
		}
	}

}
