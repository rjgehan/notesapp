package com.rjgehan.notes.vault;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.TextFile;
import com.rjgehan.notes.api.dto.WriteResult;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class FileServiceTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private FileService files;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.files = this.vault.files;
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private String create(String path, String content) throws Exception {
		return this.files.createText(path, content, OnConflict.FAIL, TestVault.ALICE, "client-a1")
			.file()
			.version();
	}

	private String save(String path, String content, String base) throws Exception {
		return this.files.saveText(path, content, base, false, TestVault.ALICE, "client-a1").result().file().version();
	}

	private static ErrorCode codeOf(ThrowingRunnable action) {
		try {
			action.run();
		}
		catch (NotesException ex) {
			return ex.code();
		}
		catch (Exception ex) {
			throw new AssertionError(ex);
		}
		throw new AssertionError("expected a NotesException");
	}

	@FunctionalInterface
	interface ThrowingRunnable {

		void run() throws Exception;

	}

	private String committed(String path) throws Exception {
		GitStore.Blob blob = this.vault.git.readAt(this.vault.git.head(), path);
		return (blob != null) ? new String(blob.bytes(), StandardCharsets.UTF_8) : null;
	}

	@Test
	void idempotentRetryWritesPublishesAndCommitsNothing() throws Exception {
		String v1 = create("Plan.md", "one\n");
		String v2 = save("Plan.md", "two\n", v1);
		this.vault.flush();
		String head = this.vault.git.head();
		int events = this.vault.hub.published.size();
		long mtime = Files.getLastModifiedTime(this.dir.resolve("Plan.md")).toMillis();

		FileService.Saved retried = this.files.saveText("Plan.md", "two\n", v1, false, TestVault.ALICE, "client-a1");

		assertThat(retried.created()).isFalse();
		assertThat(retried.result().file().version()).isEqualTo(v2);
		assertThat(this.vault.hub.published).hasSize(events);
		assertThat(this.vault.batcher.isPending("Plan.md")).isFalse();
		assertThat(this.vault.flush()).isNull();
		assertThat(this.vault.git.head()).isEqualTo(head);
		assertThat(Files.getLastModifiedTime(this.dir.resolve("Plan.md")).toMillis()).isEqualTo(mtime);
	}

	@Test
	void externalEditThenStaleSaveConflictsAndCommitsTheExternalContent() throws Exception {
		String v1 = create("Note.md", "original\n");
		this.vault.flush();
		Files.writeString(this.dir.resolve("Note.md"), "edited over ssh\n");

		assertThatThrownBy(() -> save("Note.md", "mine\n", v1)).isInstanceOfSatisfying(NotesException.class, (ex) -> {
			assertThat(ex.code()).isEqualTo(ErrorCode.VERSION_CONFLICT);
			assertThat(ex.getBody().getProperties()).containsEntry("currentContent", "edited over ssh\n");
		});
		assertThat(committed("Note.md")).isEqualTo("edited over ssh\n");
		assertThat(this.vault.hub.names()).contains("file.changed");
		assertThat(Files.readString(this.dir.resolve("Note.md"))).isEqualTo("edited over ssh\n");
	}

	@Test
	void flushHistoryKeepsBothVersionsInHistory() throws Exception {
		String v1 = create("Shared.md", "base\n");
		this.vault.flush();
		String theirs = this.files.saveText("Shared.md", "theirs\n", v1, false, TestVault.BOB, "client-b2")
			.result()
			.file()
			.version();
		assertThat(codeOf(() -> save("Shared.md", "mine\n", v1))).isEqualTo(ErrorCode.VERSION_CONFLICT);
		this.files.saveText("Shared.md", "mine\n", theirs, true, TestVault.ALICE, "client-a1");
		this.vault.flush();

		GitStore.LogPage log = this.vault.git.log("Shared.md", 0, 10);
		List<String> contents = new ArrayList<>();
		for (GitStore.LogEntry entry : log.entries()) {
			contents.add(new String(this.vault.git.readAt(entry.commit().name(), "Shared.md").bytes(),
					StandardCharsets.UTF_8));
		}
		assertThat(contents).containsExactly("mine\n", "theirs\n", "base\n");
		assertThat(log.entries().get(1).commit().getAuthorIdent().getName()).isEqualTo("Bob");
		assertThat(log.entries().get(0).commit().getAuthorIdent().getName()).isEqualTo("Alice");
	}

	@Test
	void flushHistoryWithFailingGitWritesNothing() throws Exception {
		String v1 = create("Keep.md", "base\n");
		this.vault.flush();
		String theirs = save("Keep.md", "theirs\n", v1);
		this.vault.git.failing = true;
		NotesException ex = (NotesException) org.assertj.core.api.Assertions
			.catchThrowable(() -> this.files.saveText("Keep.md", "mine\n", theirs, true, TestVault.ALICE, "client-a1"));
		assertThat(ex.code()).isEqualTo(ErrorCode.HISTORY_UNAVAILABLE);
		assertThat(ex.getBody().getProperties()).containsEntry("reason", "commit-failed");
		assertThat(Files.readString(this.dir.resolve("Keep.md"))).isEqualTo("theirs\n");
	}

	@Test
	void putWithNullBaseCreatesMissingFilesWithoutNewNameRules() throws Exception {
		FileService.Saved created = this.files.saveText("Plan #2.md", "x", null, false, TestVault.ALICE, "client-a1");
		assertThat(created.created()).isTrue();
		assertThat(Files.readString(this.dir.resolve("Plan #2.md"))).isEqualTo("x");
		assertThat(codeOf(() -> this.files.saveText("Plan #2.md", "y", null, false, TestVault.ALICE, "client-a1")))
			.isEqualTo(ErrorCode.VERSION_CONFLICT);
		assertThat(codeOf(() -> create("Plan #3.md", "z"))).isEqualTo(ErrorCode.INVALID_NAME);
	}

	@Test
	void bomFilesKeepTheirBom() throws Exception {
		Files.write(this.dir.resolve("Bom.md"), TextCodec.encode("old\n", true));
		this.vault.builder.build();
		TextFile read = this.files.readText("Bom.md");
		assertThat(read.content()).isEqualTo("old\n");
		save("Bom.md", "new\n", read.version());
		byte[] bytes = Files.readAllBytes(this.dir.resolve("Bom.md"));
		assertThat(TextCodec.hasBom(bytes)).isTrue();
		assertThat(new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8)).isEqualTo("new\n");
	}

	@Test
	void racingCreatesNeverReplaceEachOther() throws Exception {
		for (int round = 0; round < 10; round++) {
			String folder = "Race" + round;
			create(folder + "/Untitled.md", "seed");
			CountDownLatch start = new CountDownLatch(1);
			ExecutorService pool = Executors.newFixedThreadPool(3);
			List<Future<WriteResult>> results = new ArrayList<>();
			String[] contents = { "rename A", "rename B", "fail C" };
			for (int i = 0; i < 3; i++) {
				int writer = i;
				results.add(pool.submit(() -> {
					start.await();
					String path = folder + ((writer == 2) ? "/Untitled 1.md" : "/Untitled.md");
					OnConflict mode = (writer == 2) ? OnConflict.FAIL : OnConflict.RENAME;
					try {
						return this.files.createText(path, contents[writer], mode, TestVault.ALICE, "client-a1");
					}
					catch (NotesException ex) {
						assertThat(ex.code()).isEqualTo(ErrorCode.ALREADY_EXISTS);
						return null;
					}
				}));
			}
			start.countDown();
			Set<String> paths = new HashSet<>();
			for (int i = 0; i < 3; i++) {
				WriteResult result = results.get(i).get();
				if (result != null) {
					assertThat(paths.add(result.file().path())).isTrue();
					assertThat(Files.readString(this.dir.resolve(result.file().path()))).isEqualTo(contents[i]);
				}
			}
			pool.shutdown();
			assertThat(Files.readString(this.dir.resolve(folder + "/Untitled.md"))).isEqualTo("seed");
			assertThat(paths).hasSizeGreaterThanOrEqualTo(2);
		}
	}

	@Test
	void rawOverwriteOfATextFileIsRefused() throws Exception {
		create("Doc.md", "text");
		assertThat(codeOf(() -> this.files.upload("Doc.md", FileService.UploadConflict.OVERWRITE,
				new ByteArrayInputStream(new byte[] { 1 }), 1, TestVault.ALICE, "client-a1")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(Files.readString(this.dir.resolve("Doc.md"))).isEqualTo("text");
	}

	@Test
	void rawOverwriteCommitsThePreviousBytesFirst() throws Exception {
		this.files.upload("pic.png", FileService.UploadConflict.FAIL, new ByteArrayInputStream(new byte[] { 1, 2 }), 2,
				TestVault.ALICE, "client-a1");
		FileService.Saved replaced = this.files.upload("pic.png", FileService.UploadConflict.OVERWRITE,
				new ByteArrayInputStream(new byte[] { 3, 4, 5 }), 3, TestVault.ALICE, "client-a1");
		assertThat(replaced.created()).isFalse();
		assertThat(this.vault.git.readAt(this.vault.git.head(), "pic.png").bytes()).containsExactly(1, 2);
		assertThat(Files.readAllBytes(this.dir.resolve("pic.png"))).containsExactly(3, 4, 5);
	}

	@Test
	void uploadsAreLimitedAndKeepFreeSpace() throws Exception {
		TestVault small = TestVault.start(this.dir.resolve("small"), java.util.Map.of("notes.limits.max-upload-size",
				"10B", "notes.limits.min-free-space", "1B"));
		try {
			assertThat(codeOf(() -> small.files.upload("big.bin", FileService.UploadConflict.FAIL,
					new ByteArrayInputStream(new byte[11]), -1, TestVault.ALICE, "client-a1")))
				.isEqualTo(ErrorCode.TOO_LARGE);
			assertThat(codeOf(() -> small.files.upload("big.bin", FileService.UploadConflict.FAIL,
					new ByteArrayInputStream(new byte[11]), 11, TestVault.ALICE, "client-a1")))
				.isEqualTo(ErrorCode.TOO_LARGE);
		}
		finally {
			small.close();
		}
		TestVault full = TestVault.start(this.dir.resolve("full"),
				java.util.Map.of("notes.limits.min-free-space", "1000000TB"));
		try {
			assertThat(codeOf(() -> full.files.upload("x.bin", FileService.UploadConflict.FAIL,
					new ByteArrayInputStream(new byte[1]), 1, TestVault.ALICE, "client-a1")))
				.isEqualTo(ErrorCode.INSUFFICIENT_STORAGE);
		}
		finally {
			full.close();
		}
	}

	@Test
	void createEventsComeAfterTheirFolders() throws Exception {
		WriteResult result = this.files.createText("a/b/c.md", "", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		assertThat(result.createdFolders()).containsExactly("a", "a/b");
		assertThat(this.vault.hub.names()).containsExactly("folder.created", "folder.created", "file.created");
	}

	@Test
	void implicitParentsResolveCaseInsensitively() throws Exception {
		create("Daily/one.md", "");
		WriteResult result = this.files.createText("daily/two.md", "", OnConflict.FAIL, TestVault.ALICE, "client-a1");
		assertThat(result.file().path()).isEqualTo("Daily/two.md");
		assertThat(result.createdFolders()).isEmpty();
	}

	@Test
	void parentsThatAreFilesAreATypeMismatch() throws Exception {
		create("Plan.md", "");
		assertThat(codeOf(() -> create("Plan.md/child.md", ""))).isEqualTo(ErrorCode.TYPE_MISMATCH);
	}

	@Test
	void readsReportTooLargeAndNotText() throws Exception {
		TestVault small = TestVault.start(this.dir.resolve("limits"), java.util.Map.of("notes.limits.max-text-size",
				"8B"));
		try {
			Files.writeString(this.dir.resolve("limits/big.md"), "0123456789");
			Files.write(this.dir.resolve("limits/pic.png"), new byte[] { 1 });
			small.builder.build();
			assertThat(small.index.file("big.md").version()).isNull();
			assertThat(codeOf(() -> small.files.readText("big.md"))).isEqualTo(ErrorCode.TOO_LARGE);
			assertThat(codeOf(() -> small.files.readText("pic.png"))).isEqualTo(ErrorCode.NOT_TEXT);
			assertThat(codeOf(() -> small.files.readText("missing.md"))).isEqualTo(ErrorCode.NOT_FOUND);
		}
		finally {
			small.close();
		}
	}

	@Test
	void readsHaveNoSideEffects() throws Exception {
		String indexed = create("Known.md", "indexed");
		this.vault.flush();
		int events = this.vault.hub.published.size();
		Files.writeString(this.dir.resolve("Known.md"), "edited outside");
		Files.writeString(this.dir.resolve("Dropped.md"), "from outside #tag");

		TextFile read = this.files.readText("Known.md");
		assertThat(read.content()).isEqualTo("edited outside");
		assertThat(read.version()).isEqualTo(Hashing.blobId("edited outside".getBytes(StandardCharsets.UTF_8)));
		assertThat(this.files.openRaw("Known.md").size()).isEqualTo(14);
		assertThat(codeOf(() -> this.files.readText("Dropped.md"))).isEqualTo(ErrorCode.NOT_FOUND);
		assertThat(codeOf(() -> this.files.openRaw("Dropped.md"))).isEqualTo(ErrorCode.NOT_FOUND);

		assertThat(this.vault.index.file("Known.md").version()).isEqualTo(indexed);
		assertThat(this.vault.index.file("Dropped.md")).isNull();
		assertThat(this.vault.hub.published).hasSize(events);
		assertThat(this.vault.batcher.isPending("Known.md")).isFalse();
		assertThat(this.vault.batcher.isPending("Dropped.md")).isFalse();
	}

	@Test
	void savingAMovedFileReportsMovedTo() throws Exception {
		String v1 = create("Old.md", "x");
		Files.move(this.dir.resolve("Old.md"), this.dir.resolve("New.md"));
		this.vault.moveLog.record("Old.md", "New.md");
		NotesException ex = (NotesException) org.assertj.core.api.Assertions
			.catchThrowable(() -> save("Old.md", "y", v1));
		assertThat(ex.code()).isEqualTo(ErrorCode.VERSION_CONFLICT);
		assertThat(ex.getBody().getProperties()).containsEntry("movedTo", "New.md").containsEntry("currentVersion", null);
	}

}
