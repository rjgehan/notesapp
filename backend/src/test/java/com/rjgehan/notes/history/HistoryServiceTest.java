package com.rjgehan.notes.history;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.api.dto.HistoryContent;
import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.api.dto.HistoryResponse;
import com.rjgehan.notes.api.dto.HistoryRestoreRequest;
import com.rjgehan.notes.api.dto.HistoryRestoreResult;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

class HistoryServiceTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private HistoryService history;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.history = this.vault.history;
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private String create(String path, String content) throws Exception {
		return this.vault.files.createText(path, content, OnConflict.FAIL, TestVault.ALICE, "client-a1")
			.file()
			.version();
	}

	private String save(String path, String content, String base) throws Exception {
		return this.vault.files.saveText(path, content, base, false, TestVault.ALICE, "client-a1")
			.result()
			.file()
			.version();
	}

	/** Renames on disk and commits the pure rename, the way a move does. */
	private void rename(String from, String to) throws Exception {
		Files.move(this.dir.resolve(from), this.dir.resolve(to));
		this.vault.index.removeFile(from);
		this.vault.files.indexFromDisk(ApiPath.of(to));
		this.vault.batcher.commitNow("Rename " + from + " → " + to, null, Author.of(TestVault.ALICE),
				List.of(ApiPath.of(from), ApiPath.of(to)));
	}

	@Test
	void followsRenamesWithPerCommitPathsChangeTypesAndParents() throws Exception {
		String v1 = create("Plan.md", "a plan that is long enough to keep its identity\n");
		GitStore.Commit added = this.vault.flush();
		save("Plan.md", "a plan that is long enough to keep its identity\nmore\n", v1);
		GitStore.Commit modified = this.vault.flush();
		rename("Plan.md", "Roadmap.md");

		HistoryResponse response = this.history.list("Roadmap.md", 50, 0);
		List<HistoryEntry> entries = response.entries();
		assertThat(entries).extracting(HistoryEntry::change)
			.containsExactly(ChangeType.RENAMED, ChangeType.MODIFIED, ChangeType.ADDED);
		assertThat(entries).extracting(HistoryEntry::path).containsExactly("Roadmap.md", "Plan.md", "Plan.md");
		assertThat(entries.get(0).renamedFrom()).isEqualTo("Plan.md");
		assertThat(entries.get(0).message()).isEqualTo("Rename Plan.md → Roadmap.md");
		assertThat(entries.get(0).parentCommitId()).isEqualTo(modified.id());
		assertThat(entries.get(1).parentCommitId()).isEqualTo(added.id());
		assertThat(entries.get(2).parentCommitId()).isNull();
		assertThat(entries.get(1).shortId()).isEqualTo(modified.id().substring(0, 7));
		assertThat(entries.get(1).authorLogin()).isEqualTo("alice@github");
		assertThat(response.hasMore()).isFalse();

		HistoryResponse paged = this.history.list("Roadmap.md", 1, 1);
		assertThat(paged.entries()).extracting(HistoryEntry::change).containsExactly(ChangeType.MODIFIED);
		assertThat(paged.hasMore()).isTrue();
	}

	@Test
	void deletedFilesHaveHistoryReadableFromTheParent() throws Exception {
		create("Gone.md", "last words\n");
		GitStore.Commit added = this.vault.flush();
		Files.delete(this.dir.resolve("Gone.md"));
		this.vault.index.removeFile("Gone.md");
		this.vault.batcher.commitNow("Delete Gone.md", null, Author.of(TestVault.ALICE), List.of(ApiPath.of("Gone.md")));

		List<HistoryEntry> entries = this.history.list("Gone.md", 50, 0).entries();
		assertThat(entries).extracting(HistoryEntry::change).containsExactly(ChangeType.DELETED, ChangeType.ADDED);
		HistoryContent content = this.history.content("Gone.md", entries.get(0).parentCommitId());
		assertThat(content.content()).isEqualTo("last words\n");
		assertThat(entries.get(0).parentCommitId()).isEqualTo(added.id());
		NotesException absent = catchThrowableOfType(NotesException.class,
				() -> this.history.content("Gone.md", entries.get(0).commitId()));
		assertThat(absent.code()).isEqualTo(ErrorCode.NOT_FOUND);
	}

	@Test
	void restoreCommitsImmediately() throws Exception {
		String v1 = create("R.md", "one\n");
		GitStore.Commit first = this.vault.flush();
		String v2 = save("R.md", "two\n", v1);
		this.vault.flush();
		HistoryRestoreResult result = this.history.restore(new HistoryRestoreRequest("R.md", first.id(), null, v2),
				TestVault.ALICE, "client-a1");
		assertThat(result.created()).isFalse();
		assertThat(result.file().version()).isEqualTo(v1);
		assertThat(result.commitId()).isEqualTo(this.vault.git.head());
		assertThat(Files.readString(this.dir.resolve("R.md"))).isEqualTo("one\n");
		assertThat(this.vault.batcher.isPending("R.md")).isFalse();
		assertThat(this.vault.hub.names()).endsWith("file.changed", "history.committed");
	}

	@Test
	void editThenRestoreWithinTheQuietPeriodKeepsBoth() throws Exception {
		String v1 = create("E.md", "committed\n");
		GitStore.Commit first = this.vault.flush();
		String edited = save("E.md", "unsaved edit\n", v1);
		this.history.restore(new HistoryRestoreRequest("E.md", first.id(), null, edited), TestVault.ALICE,
				"client-a1");
		List<HistoryEntry> entries = this.history.list("E.md", 50, 0).entries();
		assertThat(entries).hasSize(3);
		assertThat(this.history.content("E.md", entries.get(1).commitId()).content()).isEqualTo("unsaved edit\n");
		assertThat(this.history.content("E.md", entries.get(0).commitId()).content()).isEqualTo("committed\n");
		assertThat(entries.get(0).message()).isEqualTo("Restore E.md to version " + first.id().substring(0, 7));
	}

	@Test
	void restoredBytesAreVerbatim() throws Exception {
		byte[] odd = concat(TextCodec.encode("line one\r\nline two\r\n", true), new byte[] { (byte) 0xFF, 'x' });
		Files.write(this.dir.resolve("Odd.md"), odd);
		this.vault.builder.build();
		this.vault.batcher.markDirty(ApiPath.of("Odd.md"), Author.EXTERNAL);
		GitStore.Commit original = this.vault.flush();
		String current = this.vault.index.file("Odd.md").version();
		String replaced = save("Odd.md", "plain\n", current);
		this.history.restore(new HistoryRestoreRequest("Odd.md", original.id(), null, replaced), TestVault.ALICE,
				"client-a1");
		assertThat(Files.readAllBytes(this.dir.resolve("Odd.md"))).isEqualTo(odd);
		HistoryContent content = this.history.content("Odd.md", original.id());
		assertThat(content.lossy()).isTrue();
	}

	@Test
	void textRestoreChecksBaseVersions() throws Exception {
		String v1 = create("C.md", "one\n");
		GitStore.Commit first = this.vault.flush();
		save("C.md", "two\n", v1);
		NotesException stale = catchThrowableOfType(NotesException.class, () -> this.history
			.restore(new HistoryRestoreRequest("C.md", first.id(), null, v1), TestVault.ALICE, "client-a1"));
		assertThat(stale.code()).isEqualTo(ErrorCode.VERSION_CONFLICT);
		NotesException exists = catchThrowableOfType(NotesException.class, () -> this.history
			.restore(new HistoryRestoreRequest("C.md", first.id(), null, null), TestVault.ALICE, "client-a1"));
		assertThat(exists.code()).isEqualTo(ErrorCode.ALREADY_EXISTS);
	}

	@Test
	void binaryRestoresStreamTheBlobAndNeverReadTheCurrentFile() throws Exception {
		this.vault.close();
		AtomicLong largestDiskRead = new AtomicLong();
		this.vault = TestVault.start(this.dir.resolve("vault"), java.util.Map.of(), (properties) -> new VaultFs(
				properties) {

			@Override
			public byte[] readBytes(String disk) throws IOException {
				byte[] bytes = super.readBytes(disk);
				largestDiskRead.accumulateAndGet(bytes.length, Math::max);
				return bytes;
			}

		});
		this.history = this.vault.history;
		byte[] first = new byte[256 * 1024];
		byte[] second = new byte[256 * 1024];
		java.util.Arrays.fill(first, (byte) 1);
		java.util.Arrays.fill(second, (byte) 2);
		Path clip = this.vault.root.resolve("clip.mp4");
		Files.write(clip, first);
		this.vault.builder.build();
		this.vault.batcher.markDirty(ApiPath.of("clip.mp4"), Author.EXTERNAL);
		GitStore.Commit original = this.vault.flush();
		Files.write(clip, second);
		this.vault.reconciler.reconcile(ApiPath.of("clip.mp4"));
		this.vault.flush();

		HistoryRestoreResult result = this.history.restore(
				new HistoryRestoreRequest("clip.mp4", original.id(), null, null), TestVault.ALICE, "client-a1");
		assertThat(result.created()).isFalse();
		assertThat(result.file().size()).isEqualTo(first.length);
		assertThat(Files.readAllBytes(clip)).isEqualTo(first);
		assertThat(this.vault.git.largestBlobRead.get()).as("blob bytes buffered").isZero();
		assertThat(largestDiskRead.get()).as("current file bytes buffered").isLessThan(first.length);
		try (var temp = Files.list(this.vault.root.resolve(".notesapp/tmp"))) {
			assertThat(temp).isEmpty();
		}
	}

	@Test
	void restoreRecreatesDeletedFilesWithTheirFolders() throws Exception {
		create("Folder/Lost.md", "content\n");
		GitStore.Commit first = this.vault.flush();
		this.vault.fs.deleteRecursively(this.dir.resolve("Folder"));
		this.vault.index.removeFolder("Folder");
		HistoryRestoreResult result = this.history.restore(
				new HistoryRestoreRequest("Folder/Lost.md", first.id(), null, null), TestVault.ALICE, "client-a1");
		assertThat(result.created()).isTrue();
		assertThat(result.createdFolders()).containsExactly("Folder");
		assertThat(Files.readString(this.dir.resolve("Folder/Lost.md"))).isEqualTo("content\n");
	}

	@Test
	void historyOfNfdNamedFiles() throws Exception {
		String nfd = Normalizer.normalize("Résumé.md", Normalizer.Form.NFD);
		Files.writeString(this.dir.resolve(nfd), "v1\n");
		this.vault.builder.build();
		this.vault.batcher.markDirty(new ApiPath("Résumé.md", nfd), Author.EXTERNAL);
		GitStore.Commit commit = this.vault.flush();
		HistoryResponse response = this.history.list("Résumé.md", 50, 0);
		assertThat(response.entries()).hasSize(1);
		assertThat(response.entries().get(0).path()).isEqualTo("Résumé.md");
		assertThat(this.history.content("Résumé.md", commit.id()).content()).isEqualTo("v1\n");
		assertThat(this.history.content(nfd, commit.id()).content()).isEqualTo("v1\n");
	}

	@Test
	void commitIdsMustBeFullHexIds() {
		NotesException ex = catchThrowableOfType(NotesException.class, () -> this.history.content("x.md", "HEAD"));
		assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void detachedHeadMakesHistoryUnavailable() throws Exception {
		create("x.md", "x");
		GitStore.Commit commit = this.vault.flush();
		this.vault.close();
		try (Git git = Git.open(this.dir.toFile())) {
			git.checkout().setName(commit.id()).call();
		}
		TestVault detached = TestVault.start(this.dir);
		try {
			NotesException ex = catchThrowableOfType(NotesException.class, () -> detached.history.list("x.md", 50, 0));
			assertThat(ex.code()).isEqualTo(ErrorCode.HISTORY_UNAVAILABLE);
			assertThat(ex.getBody().getProperties()).containsEntry("reason", "unusable: HEAD is detached");
			String version = detached.index.file("x.md").version();
			detached.files.saveText("x.md", "still saves", version, false, TestVault.ALICE, "client-a1");
			assertThat(Files.readString(this.dir.resolve("x.md"))).isEqualTo("still saves");
		}
		finally {
			detached.close();
		}
	}

	@Test
	void importingMakesHistoryUnavailable() {
		this.vault.batcher.beginImport();
		NotesException ex = catchThrowableOfType(NotesException.class, () -> this.history.list("x.md", 50, 0));
		assertThat(ex.getBody().getProperties()).containsEntry("reason", "importing");
		this.vault.batcher.endImport();
	}

	@Test
	void commitNowReturnsNullWhenNothingIsPending() throws Exception {
		assertThat(this.history.commitPending()).isNull();
		create("n.md", "n");
		assertThat(this.history.commitPending()).isNotNull();
	}

	private static byte[] concat(byte[] a, byte[] b) {
		byte[] out = new byte[a.length + b.length];
		System.arraycopy(a, 0, out, 0, a.length);
		System.arraycopy(b, 0, out, a.length, b.length);
		return out;
	}

	static String text(byte[] bytes) {
		return new String(bytes, StandardCharsets.UTF_8);
	}

}
