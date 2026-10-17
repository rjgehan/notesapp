package com.rjgehan.notes.history;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.api.dto.HistoryExclusion;
import com.rjgehan.notes.api.dto.HistoryResponse;
import com.rjgehan.notes.api.dto.HistoryRestoreRequest;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.HistoryCommittedEvent;
import com.rjgehan.notes.events.TrashChangedEvent;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileService.UploadConflict;
import com.rjgehan.notes.vault.Hashing;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.PersonIdent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The large-file policy (ROADMAP item 23, DESIGN §5.8) end to end, with a 1 KB threshold: such files stay in the
 * vault but no version of them above the threshold ever becomes a git object.
 */
class LargeFilePolicyTest {

	private static final String CLIENT = "client-a1";

	private static final Map<String, String> ONE_KB = Map.of("notes.git.large-file-threshold", "1KB");

	@TempDir
	Path dir;

	private TestVault vault;

	@AfterEach
	void tearDown() {
		if (this.vault != null) {
			this.vault.close();
		}
	}

	private TestVault start(Map<String, String> overrides) throws Exception {
		this.vault = TestVault.start(this.dir, overrides);
		return this.vault;
	}

	private static byte[] bytes(int size, int seed) {
		byte[] data = new byte[size];
		for (int i = 0; i < size; i++) {
			data[i] = (byte) (seed + i % 251);
		}
		return data;
	}

	private void upload(String path, byte[] data, UploadConflict conflict) throws Exception {
		this.vault.files.upload(path, conflict, new ByteArrayInputStream(data), data.length, TestVault.ALICE, CLIENT);
	}

	private org.eclipse.jgit.lib.Repository repository() {
		GitStore git = this.vault.git;
		return git.repository();
	}

	/** True when git has an object with these bytes: the policy failed if a large version ever became one. */
	private boolean inGit(byte[] data) throws Exception {
		return repository().getObjectDatabase().has(ObjectId.fromString(Hashing.blobId(data)));
	}

	private String exclude() throws Exception {
		return Files.readString(this.dir.resolve(".git/info/exclude"), StandardCharsets.UTF_8);
	}


	private org.eclipse.jgit.revwalk.RevCommit lastCommit() throws Exception {
		try (var walk = new org.eclipse.jgit.revwalk.RevWalk(repository())) {
			return walk.parseCommit(repository().resolve("HEAD"));
		}
	}

	@Test
	void aNewLargeFileStaysInTheVaultButOutOfHistory() throws Exception {
		start(ONE_KB);
		byte[] big = bytes(2048, 1);
		upload("Attachments/big.bin", big, UploadConflict.FAIL);
		this.vault.files.createText("note.md", "small", OnConflict.FAIL, TestVault.ALICE, CLIENT);
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.subject()).isEqualTo("Create note.md");
		assertThat(commit.paths()).containsExactly("note.md");
		assertThat(this.vault.git.readAt(commit.id(), "Attachments/big.bin")).isNull();
		assertThat(inGit(big)).isFalse();
		assertThat(Files.readAllBytes(this.dir.resolve("Attachments/big.bin"))).isEqualTo(big);
		assertThat(exclude()).contains("# kept out of history, larger than 1 KB").endsWith("/Attachments/big.bin\n");
		LargeFiles.Snapshot snapshot = this.vault.largeFiles.current();
		assertThat(snapshot.files()).extracting(LargeFiles.Entry::path).containsExactly("Attachments/big.bin");
		assertThat(snapshot.bytes()).isEqualTo(2048);
	}

	@Test
	void aBatchWithOnlyALargeFileMakesNoCommit() throws Exception {
		start(ONE_KB);
		this.vault.files.createText("seed.md", "seed", OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.flush();
		String head = this.vault.git.head();
		long events = this.vault.hub.published.stream().filter(HistoryCommittedEvent.class::isInstance).count();
		upload("video.bin", bytes(4096, 2), UploadConflict.FAIL);
		assertThat(this.vault.flush()).isNull();
		assertThat(this.vault.git.head()).isEqualTo(head);
		assertThat(this.vault.hub.published.stream().filter(HistoryCommittedEvent.class::isInstance).count())
			.isEqualTo(events);
	}

	@Test
	void aFileThatGrowsPastTheLimitStopsBeingVersionedAndKeepsItsHistory() throws Exception {
		start(ONE_KB);
		byte[] small = bytes(500, 3);
		upload("doc.pdf", small, UploadConflict.FAIL);
		GitStore.Commit first = this.vault.flush();
		byte[] big = bytes(3000, 4);
		upload("doc.pdf", big, UploadConflict.OVERWRITE);
		GitStore.Commit stop = this.vault.flush();
		assertThat(stop.subject()).isEqualTo("Stop versioning doc.pdf (larger than 1 KB)");
		assertThat(stop.paths()).containsExactly("doc.pdf");
		assertThat(this.vault.git.readAt(stop.id(), "doc.pdf")).isNull();
		assertThat(this.vault.git.readAt(first.id(), "doc.pdf").bytes()).isEqualTo(small);
		assertThat(inGit(big)).isFalse();
		assertThat(Files.readAllBytes(this.dir.resolve("doc.pdf"))).isEqualTo(big);

		HistoryResponse history = this.vault.history.list("doc.pdf", 50, 0);
		assertThat(history.excluded()).isEqualTo(new HistoryExclusion(HistoryExclusion.Reason.LARGE_FILE, 3000, 1024));
		assertThat(history.pending()).isFalse();
		assertThat(history.entries()).extracting((e) -> e.change())
			.containsExactly(ChangeType.DELETED, ChangeType.ADDED);
		// The small version was not large, so replacing it kept nothing in the trash: it is in history.
		assertThat(this.vault.trash.list()).isEmpty();

		// Later edits of the large file never reach git, and its history never shows them as pending.
		upload("doc.pdf", bytes(3500, 5), UploadConflict.OVERWRITE);
		assertThat(this.vault.history.list("doc.pdf", 50, 0).pending()).isFalse();
		assertThat(this.vault.flush()).isNull();
		assertThat(inGit(bytes(3500, 5))).isFalse();
	}

	@Test
	void anOrdinaryChangeAndAStoppedFileShareACommitThatSaysBoth() throws Exception {
		start(ONE_KB);
		upload("a.bin", bytes(100, 6), UploadConflict.FAIL);
		this.vault.files.createText("n.md", "one", OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.flush();
		upload("a.bin", bytes(2000, 7), UploadConflict.OVERWRITE);
		String version = this.vault.index.file("n.md").version();
		this.vault.files.saveText("n.md", "two", version, false, TestVault.ALICE, CLIENT);
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.subject()).isEqualTo("Update n.md");
		assertThat(lastCommit().getFullMessage()).contains("Stopped versioning a.bin (larger than 1 KB)");
		assertThat(commit.paths()).containsExactlyInAnyOrder("a.bin", "n.md");
		assertThat(inGit(bytes(2000, 7))).isFalse();
	}

	@Test
	void aLargeFileThatShrinksIsVersionedAgainAndTheLargeVersionGoesToTheTrash() throws Exception {
		start(ONE_KB);
		byte[] big = bytes(2048, 8);
		upload("clip.bin", big, UploadConflict.FAIL);
		this.vault.flush();
		byte[] small = bytes(100, 9);
		upload("clip.bin", small, UploadConflict.OVERWRITE);
		GitStore.Commit commit = this.vault.flush();
		assertThat(exclude()).doesNotContain("/clip.bin");
		assertThat(commit.subject()).isEqualTo("Create clip.bin");
		assertThat(this.vault.git.readAt(commit.id(), "clip.bin").bytes()).isEqualTo(small);
		assertThat(inGit(big)).isFalse();
		List<TrashEntry> trash = this.vault.trash.list();
		assertThat(trash).singleElement().satisfies((entry) -> {
			assertThat(entry.originalPath()).isEqualTo("clip.bin");
			assertThat(entry.size()).isEqualTo(2048);
			assertThat(entry.deletedBy()).isEqualTo("alice@github");
		});
		assertThat(Files.readAllBytes(this.vault.trash.openRaw(trash.get(0).id()).file())).isEqualTo(big);
	}

	@Test
	void replacingALargeFileKeepsTheReplacedVersionInTheTrashAndAnnouncesIt() throws Exception {
		start(ONE_KB);
		byte[] first = bytes(5000, 10);
		upload("movie.bin", first, UploadConflict.FAIL);
		this.vault.hub.published.clear();
		byte[] second = bytes(6000, 11);
		upload("movie.bin", second, UploadConflict.OVERWRITE);
		assertThat(Files.readAllBytes(this.dir.resolve("movie.bin"))).isEqualTo(second);
		List<TrashEntry> trash = this.vault.trash.list();
		assertThat(trash).singleElement().extracting(TrashEntry::originalPath).isEqualTo("movie.bin");
		assertThat(Files.readAllBytes(this.vault.trash.openRaw(trash.get(0).id()).file())).isEqualTo(first);
		List<VaultEvent> events = this.vault.hub.published;
		assertThat(events).hasSize(2);
		assertThat(events.get(0)).isInstanceOf(FileEvent.class);
		assertThat(events.get(1)).isInstanceOf(TrashChangedEvent.class);
		// The copy in the trash is independent of the file: changing the file leaves it alone.
		upload("movie.bin", bytes(7000, 12), UploadConflict.OVERWRITE);
		assertThat(Files.readAllBytes(this.vault.trash.openRaw(trash.get(0).id()).file())).isEqualTo(first);
		assertThat(this.vault.trash.list()).hasSize(2);
	}

	@Test
	void restoringAnOldVersionOverALargeFileKeepsTheLargeOneInTheTrash() throws Exception {
		start(ONE_KB);
		byte[] small = bytes(300, 13);
		upload("scan.bin", small, UploadConflict.FAIL);
		GitStore.Commit first = this.vault.flush();
		byte[] big = bytes(4000, 14);
		upload("scan.bin", big, UploadConflict.OVERWRITE);
		this.vault.flush();
		this.vault.history.restore(new HistoryRestoreRequest("scan.bin", first.id(), null, null), TestVault.ALICE,
				CLIENT);
		assertThat(Files.readAllBytes(this.dir.resolve("scan.bin"))).isEqualTo(small);
		assertThat(lastCommit().getShortMessage()).isEqualTo("Restore scan.bin to version " + first.id().substring(0, 7));
		List<TrashEntry> trash = this.vault.trash.list();
		assertThat(trash).singleElement().extracting(TrashEntry::size).isEqualTo(4000L);
		assertThat(Files.readAllBytes(this.vault.trash.openRaw(trash.get(0).id()).file())).isEqualTo(big);
		assertThat(this.vault.hub.names()).containsSubsequence("file.changed", "trash.changed", "history.committed");
	}

	@Test
	void movingAFolderMovesItsExclusions() throws Exception {
		start(ONE_KB);
		byte[] big = bytes(2048, 15);
		upload("A/big.bin", big, UploadConflict.FAIL);
		this.vault.files.createText("A/n.md", "n", OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.flush();
		this.vault.moves.move("A", "B", false, false, TestVault.ALICE, CLIENT);
		assertThat(exclude()).contains("/B/big.bin").doesNotContain("/A/big.bin");
		String head = this.vault.git.head();
		assertThat(this.vault.git.readAt(head, "B/n.md")).isNotNull();
		assertThat(this.vault.git.readAt(head, "B/big.bin")).isNull();
		assertThat(inGit(big)).isFalse();
	}

	@Test
	void globCharactersInANameNeverExcludeAnotherFile() throws Exception {
		start(ONE_KB);
		byte[] big = bytes(2048, 16);
		byte[] small = bytes(10, 17);
		Files.write(this.dir.resolve("Scan [1].bin"), big);
		Files.write(this.dir.resolve("Scan 1.bin"), small);
		this.vault.reconciler.reconcile(ApiPath.of("Scan [1].bin"));
		this.vault.reconciler.reconcile(ApiPath.of("Scan 1.bin"));
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.paths()).containsExactly("Scan 1.bin");
		assertThat(exclude()).contains("/Scan \\[1].bin");
		assertThat(inGit(big)).isFalse();
		assertThat(inGit(small)).isTrue();
	}

	@Test
	void aFileStillGrowingOnDiskIsKeptOutBeforeTheIndexCatchesUp() throws Exception {
		start(ONE_KB);
		upload("copy.bin", bytes(100, 18), UploadConflict.FAIL);
		this.vault.flush();
		// An external copy is still writing: the disk is ahead of the index when the commit runs.
		byte[] big = bytes(5000, 19);
		Files.write(this.dir.resolve("copy.bin"), big);
		this.vault.batcher.markDirty(ApiPath.of("copy.bin"), Author.EXTERNAL);
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.subject()).isEqualTo("Stop versioning copy.bin (larger than 1 KB)");
		assertThat(inGit(big)).isFalse();
	}

	@Test
	void startupStopsTrackingLargeFilesAnOlderRepositoryHas() throws Exception {
		byte[] big = bytes(3000, 20);
		try (Git git = Git.init().setDirectory(this.dir.toFile()).setInitialBranch("main").call()) {
			Files.write(this.dir.resolve("big.bin"), big);
			Files.writeString(this.dir.resolve("a.md"), "a");
			git.add().addFilepattern(".").call();
			PersonIdent someone = new PersonIdent("Someone", "someone@example.com");
			git.commit().setMessage("Seed").setAuthor(someone).setCommitter(someone).call();
		}
		start(ONE_KB);
		assertThat(this.vault.git.tracksLargeFiles()).isTrue();
		GitBootstrap bootstrap = new GitBootstrap(this.vault.git, this.vault.batcher, this.vault.hub,
				this.vault.properties);
		this.vault.batcher.beginImport();
		bootstrap.run();
		assertThat(lastCommit().getShortMessage()).isEqualTo("Stop versioning big.bin (larger than 1 KB)");
		assertThat(this.vault.git.tracksLargeFiles()).isFalse();
		assertThat(this.vault.git.isDirty()).isFalse();
		assertThat(Files.readAllBytes(this.dir.resolve("big.bin"))).isEqualTo(big);
	}

	@Test
	void importingAVaultLeavesLargeFilesOutOfTheFirstCommit() throws Exception {
		byte[] big = bytes(3000, 21);
		Files.write(this.dir.resolve("big.bin"), big);
		Files.writeString(this.dir.resolve("a.md"), "a");
		start(ONE_KB);
		GitBootstrap bootstrap = new GitBootstrap(this.vault.git, this.vault.batcher, this.vault.hub,
				this.vault.properties);
		this.vault.batcher.beginImport();
		bootstrap.run();
		assertThat(lastCommit().getShortMessage()).isEqualTo("Import existing vault (1 files)");
		assertThat(inGit(big)).isFalse();
		assertThat(this.vault.git.isDirty()).isFalse();
	}

	@Test
	void aThresholdOfZeroVersionsEveryFile() throws Exception {
		start(Map.of("notes.git.large-file-threshold", "0"));
		byte[] big = bytes(3000, 22);
		upload("big.bin", big, UploadConflict.FAIL);
		this.vault.flush();
		assertThat(inGit(big)).isTrue();
		assertThat(exclude()).isEqualTo(GitStore.EXCLUDE);
		assertThat(this.vault.largeFiles.current().files()).isEmpty();
		assertThat(this.vault.history.list("big.bin", 50, 0).excluded()).isNull();
	}

	@Test
	void theDefaultThresholdIs25Megabytes() throws Exception {
		start(Map.of());
		assertThat(this.vault.largeFiles.limit()).isEqualTo(25L * 1024 * 1024);
		assertThat(exclude()).startsWith(GitStore.EXCLUDE).contains("larger than 25 MB");
		assertThat(this.vault.git.head()).isNull();
	}

}
