package com.rjgehan.notes.watch;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.events.FileDeletedEvent;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.FolderDeletedEvent;
import com.rjgehan.notes.events.ResyncEvent;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.VaultLocks;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/** The per-path reconcile that services run inline; the watcher and full rescan build on it. */
class VaultReconcilerTest {

	@TempDir
	Path dir;

	private TestVault vault;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private void reconcile(String path) {
		this.vault.reconciler.reconcile(ApiPath.of(path));
	}

	@Test
	void externalCreateModifyAndDeleteAreAnnouncedAndCommittedAsExternal() throws Exception {
		Files.writeString(this.dir.resolve("ext.md"), "one");
		reconcile("ext.md");
		Files.writeString(this.dir.resolve("ext.md"), "two");
		reconcile("ext.md");
		Files.delete(this.dir.resolve("ext.md"));
		reconcile("ext.md");
		assertThat(this.vault.hub.names()).containsExactly("file.created", "file.changed", "file.deleted");
		for (VaultEvent event : this.vault.hub.published) {
			assertThat(event.echoOrigin()).isNull();
		}
		FileDeletedEvent deleted = (FileDeletedEvent) this.vault.hub.published.get(2);
		assertThat(deleted.trashed()).isFalse();
		assertThat(deleted.trashId()).isNull();

		Files.writeString(this.dir.resolve("kept.md"), "kept");
		reconcile("kept.md");
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.author().name()).isEqualTo("External");
		assertThat(commit.subject()).startsWith("External changes:");
	}

	@Test
	void theAppsOwnWritesProduceNoEvent() throws Exception {
		this.vault.files.createText("own.md", "x", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		int events = this.vault.hub.published.size();
		reconcile("own.md");
		assertThat(this.vault.hub.published).hasSize(events);
	}

	@Test
	void binaryFilesAreComparedBySizeAndMtime() throws Exception {
		Path pic = this.dir.resolve("pic.png");
		Files.write(pic, new byte[] { 1, 2, 3 });
		reconcile("pic.png");
		reconcile("pic.png");
		assertThat(this.vault.hub.names()).containsExactly("file.created");
		Files.write(pic, new byte[] { 4, 5, 6 });
		Files.setLastModifiedTime(pic, FileTime.from(Instant.parse("2020-01-01T00:00:00Z")));
		reconcile("pic.png");
		assertThat(this.vault.hub.names()).containsExactly("file.created", "file.changed");
		assertThat(((FileEvent) this.vault.hub.published.get(1)).file().version()).isNull();
	}

	@Test
	void anExternalFolderDeleteGivesOneFolderDeletedEvent() throws Exception {
		this.vault.files.createText("Dir/a.md", "a", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.files.createText("Dir/Sub/b.md", "b", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.flush();
		this.vault.hub.published.clear();
		this.vault.fs.deleteRecursively(this.dir.resolve("Dir"));
		reconcile("Dir");
		assertThat(this.vault.hub.published).hasSize(1).first().isInstanceOf(FolderDeletedEvent.class);
		assertThat(this.vault.index.file("Dir/Sub/b.md")).isNull();
		assertThat(this.vault.index.isFolder("Dir/Sub")).isFalse();
		assertThat(this.vault.batcher.isPending("Dir/a.md")).isTrue();
		assertThat(this.vault.batcher.isPending("Dir/Sub/b.md")).isTrue();
	}

	@Test
	void anExternalMoveIsADeletePlusACreate() throws Exception {
		this.vault.files.createText("from.md", "text", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.hub.published.clear();
		Files.move(this.dir.resolve("from.md"), this.dir.resolve("to.md"));
		reconcile("from.md");
		reconcile("to.md");
		assertThat(this.vault.hub.names()).containsExactly("file.deleted", "file.created");
	}

	@Test
	void newExternalFoldersAreReconciledAsASubtree() throws Exception {
		Files.createDirectories(this.dir.resolve("New/Inner"));
		Files.writeString(this.dir.resolve("New/Inner/x.md"), "x");
		reconcile("New/Inner/x.md");
		assertThat(this.vault.hub.names()).containsExactly("folder.created", "folder.created", "file.created");
		assertThat(this.vault.index.file("New/Inner/x.md")).isNotNull();
	}

	@Test
	void moreThanFiftyChangesBecomeOneResync() throws Exception {
		Files.createDirectories(this.dir.resolve("Bulk"));
		for (int i = 0; i < 60; i++) {
			Files.writeString(this.dir.resolve("Bulk/n" + i + ".md"), "n" + i);
		}
		reconcile("Bulk");
		assertThat(this.vault.hub.published).hasSize(1).first().isInstanceOf(ResyncEvent.class);
		assertThat(this.vault.index.file("Bulk/n59.md")).isNotNull();
	}

	@Test
	void aFullRescanFindsEveryKindOfChange() throws Exception {
		this.vault.files.createText("kept.md", "kept", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.files.createText("edited.md", "v1", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.files.createText("gone.md", "x", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.files.createText("Old/inner.md", "x", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.flush();
		this.vault.hub.published.clear();
		Files.writeString(this.dir.resolve("edited.md"), "v2 is longer");
		Files.delete(this.dir.resolve("gone.md"));
		Files.writeString(this.dir.resolve("added.md"), "new");
		Files.createDirectories(this.dir.resolve("New/Deep"));
		Files.writeString(this.dir.resolve("New/Deep/n.md"), "n");
		this.vault.fs.deleteRecursively(this.dir.resolve("Old"));
		Files.writeString(this.dir.resolve(".hidden.md"), "ignored");

		int changes = this.vault.reconciler.fullRescan(false);
		assertThat(changes).isEqualTo(7);
		assertThat(this.vault.hub.names()).containsExactlyInAnyOrder("file.changed", "file.deleted", "file.created",
				"folder.created", "folder.created", "file.created", "folder.deleted");
		assertThat(this.vault.index.file("New/Deep/n.md")).isNotNull();
		assertThat(this.vault.index.file("gone.md")).isNull();
		assertThat(this.vault.index.isFolder("Old")).isFalse();
		assertThat(this.vault.batcher.isPending("edited.md")).isTrue();
		VaultReconciler.RescanInfo info = this.vault.reconciler.lastRescan();
		assertThat(info).isNotNull();
		assertThat(info.repoBytes()).isPositive();
		assertThat(info.unwritableDirs()).isEmpty();

		this.vault.hub.published.clear();
		assertThat(this.vault.reconciler.fullRescan(false)).isZero();
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void aTouchedButUnchangedTextFileIsNotAChange() throws Exception {
		this.vault.files.createText("same.md", "same", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		this.vault.hub.published.clear();
		Files.setLastModifiedTime(this.dir.resolve("same.md"), FileTime.from(Instant.parse("2020-01-01T00:00:00Z")));
		assertThat(this.vault.reconciler.fullRescan(false)).isZero();
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void aBulkRescanPublishesOneResync() throws Exception {
		for (int i = 0; i < 60; i++) {
			Files.writeString(this.dir.resolve("n" + i + ".md"), "n" + i);
		}
		assertThat(this.vault.reconciler.fullRescan(false)).isEqualTo(60);
		assertThat(this.vault.hub.published).singleElement()
			.isEqualTo(new ResyncEvent(ResyncEvent.Reason.BULK_CHANGE));
		assertThat(this.vault.index.file("n59.md")).isNotNull();
	}

	@Test
	void aRescanAfterAnOverflowAlwaysAsksClientsToResync() {
		assertThat(this.vault.reconciler.fullRescan(true)).isZero();
		assertThat(this.vault.hub.published).singleElement()
			.isEqualTo(new ResyncEvent(ResyncEvent.Reason.WATCHER_OVERFLOW));
	}

	@Test
	void aRescanOnlyTakesPerPathLocks() throws Exception {
		// "saved.md" and "held.md" fall on different lock stripes.
		this.vault.files.createText("saved.md", "v1", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		Files.writeString(this.dir.resolve("held.md"), "external");
		CountDownLatch held = new CountDownLatch(1);
		CountDownLatch release = new CountDownLatch(1);
		Thread holder = Thread.ofPlatform().start(() -> {
			try (VaultLocks.Held lock = this.vault.locks.read("held.md")) {
				held.countDown();
				release.await();
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		});
		held.await();
		CompletableFuture<Integer> rescan = CompletableFuture.supplyAsync(() -> this.vault.reconciler.fullRescan(false));
		try {
			Thread.sleep(200);
			assertThat(rescan).isNotDone();
			long started = System.nanoTime();
			String version = this.vault.index.file("saved.md").version();
			this.vault.files.saveText("saved.md", "v2", version, false, TestVault.ALICE, "client-a1");
			assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(1));
		}
		finally {
			release.countDown();
			holder.join();
		}
		assertThat(rescan.get(10, TimeUnit.SECONDS)).isEqualTo(1);
		assertThat(this.vault.index.file("held.md")).isNotNull();
	}

	@Test
	void caseDifferencesAreNotTheSameFile() throws Exception {
		Files.writeString(this.dir.resolve("Upper.md"), "x");
		reconcile("upper.md");
		assertThat(this.vault.index.file("upper.md")).isNull();
		assertThat(this.vault.hub.published).isEmpty();
	}

}
