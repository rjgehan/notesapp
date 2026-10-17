package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.RestoreRequest;
import com.rjgehan.notes.api.dto.RestoreResult;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.FileDeletedEvent;
import com.rjgehan.notes.events.FolderDeletedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Delete to trash, the flat layout, restore, purge and empty (DESIGN §5.7). */
class TrashServiceTest {

	private static final String CLIENT = "client-a1";

	@TempDir
	Path dir;

	private TestVault vault;

	@BeforeEach
	void setUp() throws IOException {
		this.vault = TestVault.start(this.dir);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private void create(String path, String content) throws IOException {
		this.vault.files.createText(path, content, OnConflict.FAIL, TestVault.ALICE, CLIENT);
	}

	private void writeOnDisk(String path, String content) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private void rebuild() throws IOException {
		this.vault.builder.build();
	}

	private RestoreResult restore(String id, RestoreRequest request) throws IOException {
		return this.vault.trash.restore(id, request, TestVault.ALICE, CLIENT);
	}

	@Test
	void aDeletedFileLandsFlatInTheTrashAndComesBack() throws Exception {
		create("Projects/Plan.md", "# Plan\n");
		create("Welcome.md", "See [[Plan]]\n");
		this.vault.flush();
		this.vault.hub.published.clear();

		TrashEntry entry = this.vault.trash.deleteFile("Projects/Plan.md", TestVault.ALICE, CLIENT);
		assertThat(entry.id()).matches("[0-9A-HJKMNP-TV-Z]{12}");
		assertThat(entry.originalPath()).isEqualTo("Projects/Plan.md");
		assertThat(entry.type()).isEqualTo(EntryType.FILE);
		assertThat(entry.deletedBy()).isEqualTo("alice@github");
		assertThat(entry.fileCount()).isEqualTo(1);
		assertThat(this.dir.resolve(".trash/Plan.md")).hasContent("# Plan");
		assertThat(this.dir.resolve("Projects/Plan.md")).doesNotExist();
		assertThat(this.vault.index.file("Projects/Plan.md")).isNull();
		assertThat(this.vault.index.resolveLink("Plan", "Welcome.md")).isNull();
		assertThat(this.vault.hub.names()).containsExactly("file.deleted", "trash.changed", "history.committed");
		FileDeletedEvent deleted = (FileDeletedEvent) this.vault.hub.published.get(0);
		assertThat(deleted.trashed()).isTrue();
		assertThat(deleted.trashId()).isEqualTo(entry.id());
		assertThat(deleted.origin()).isEqualTo(CLIENT);
		assertThat(this.vault.trash.list()).containsExactly(entry);
		assertThat(Files.readString(this.dir.resolve(".notesapp/trash.json"))).contains("\"trashPath\"",
				"Projects/Plan.md");

		this.vault.hub.published.clear();
		RestoreResult restored = restore(entry.id(), null);
		assertThat(restored.type()).isEqualTo(EntryType.FILE);
		assertThat(restored.path()).isEqualTo("Projects/Plan.md");
		assertThat(restored.files()).singleElement().satisfies((file) -> assertThat(file.version()).isNotNull());
		assertThat(restored.commitId()).isNotNull();
		assertThat(this.vault.index.resolveLink("Plan", "Welcome.md")).isEqualTo("Projects/Plan.md");
		assertThat(this.vault.index.backlinkSources("Projects/Plan.md")).containsExactly("Welcome.md");
		assertThat(this.vault.trash.list()).isEmpty();
		assertThat(this.vault.hub.names()).containsExactly("file.created", "trash.changed", "history.committed");
		List<HistoryEntry> history = this.vault.history.list("Projects/Plan.md", 10, 0).entries();
		assertThat(history).extracting(HistoryEntry::message)
			.containsExactly("Restore Projects/Plan.md from trash", "Delete Projects/Plan.md",
					"Update 2 files: Projects/Plan.md, Welcome.md");
	}

	@Test
	void aFolderIsOneTrashEntry() throws Exception {
		create("Archive/a.md", "a");
		create("Archive/Sub/b.md", "b");
		this.vault.flush();
		this.vault.hub.published.clear();
		TrashEntry entry = this.vault.trash.deleteFolder("Archive", TestVault.ALICE, CLIENT);
		assertThat(entry.type()).isEqualTo(EntryType.FOLDER);
		assertThat(entry.fileCount()).isEqualTo(2);
		assertThat(entry.size()).isEqualTo(2);
		assertThat(this.dir.resolve(".trash/Archive/Sub/b.md")).exists();
		assertThat(this.vault.index.isFolder("Archive")).isFalse();
		assertThat(this.vault.index.isFolder("Archive/Sub")).isFalse();
		assertThat(this.vault.hub.names()).containsExactly("folder.deleted", "trash.changed", "history.committed");
		assertThat(((FolderDeletedEvent) this.vault.hub.published.get(0)).trashId()).isEqualTo(entry.id());
		assertThat(this.vault.history.list("Archive/Sub/b.md", 5, 0).entries().get(0).message())
			.isEqualTo("Delete folder Archive (2 files)");

		this.vault.hub.published.clear();
		RestoreResult restored = restore(entry.id(), new RestoreRequest(null, null));
		assertThat(restored.type()).isEqualTo(EntryType.FOLDER);
		assertThat(restored.files()).hasSize(2);
		assertThat(restored.createdFolders()).containsExactly("Archive", "Archive/Sub");
		assertThat(this.vault.index.file("Archive/Sub/b.md")).isNotNull();
		assertThat(this.vault.hub.names()).containsExactly("folder.created", "folder.created", "file.created",
				"file.created", "trash.changed", "history.committed");
	}

	@Test
	void anEmptyFolderMakesNoCommit() throws Exception {
		this.vault.folders.create("Empty", TestVault.ALICE, CLIENT);
		this.vault.hub.published.clear();
		this.vault.trash.deleteFolder("Empty", TestVault.ALICE, CLIENT);
		assertThat(this.vault.hub.names()).containsExactly("folder.deleted", "trash.changed");
	}

	@Test
	void aFileDeletedAfterItsTrashedFolderIsASeparateEntry() throws Exception {
		create("A/B.md", "first");
		this.vault.trash.deleteFolder("A", TestVault.ALICE, CLIENT);
		create("A/B.md", "second");
		this.vault.trash.deleteFile("A/B.md", TestVault.ALICE, CLIENT);
		assertThat(this.vault.trash.list()).extracting(TrashEntry::originalPath).containsExactlyInAnyOrder("A",
				"A/B.md");
		assertThat(this.dir.resolve(".trash/B.md")).hasContent("second");
		assertThat(this.dir.resolve(".trash/A/B.md")).hasContent("first");
	}

	@Test
	void concurrentDeletesOfTheSameNameGetDistinctTrashNames() throws Exception {
		create("X/Plan.md", "x");
		create("Y/Plan.md", "y");
		CountDownLatch start = new CountDownLatch(1);
		ExecutorService pool = Executors.newFixedThreadPool(2);
		try {
			List<Callable<TrashEntry>> tasks = List.of(() -> {
				start.await();
				return this.vault.trash.deleteFile("X/Plan.md", TestVault.ALICE, CLIENT);
			}, () -> {
				start.await();
				return this.vault.trash.deleteFile("Y/Plan.md", TestVault.BOB, "client-b1");
			});
			List<Future<TrashEntry>> futures = tasks.stream().map(pool::submit).toList();
			start.countDown();
			for (Future<TrashEntry> future : futures) {
				future.get();
			}
		}
		finally {
			pool.shutdownNow();
		}
		assertThat(this.dir.resolve(".trash/Plan.md")).exists();
		assertThat(this.dir.resolve(".trash/Plan 1.md")).exists();
		assertThat(this.vault.trash.list()).extracting(TrashEntry::originalPath)
			.containsExactlyInAnyOrder("X/Plan.md", "Y/Plan.md");
		String metadata = Files.readString(this.dir.resolve(".notesapp/trash.json"));
		assertThat(metadata).contains("\"Plan.md\"", "\"Plan 1.md\"");
	}

	@Test
	void restoreConflictsFailOrRename() throws Exception {
		create("Plan.md", "old");
		TrashEntry entry = this.vault.trash.deleteFile("Plan.md", TestVault.ALICE, CLIENT);
		create("Plan.md", "new");
		assertThatThrownBy(() -> restore(entry.id(), null)).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.ALREADY_EXISTS));
		RestoreResult renamed = restore(entry.id(), new RestoreRequest(null, OnConflict.RENAME));
		assertThat(renamed.path()).isEqualTo("Plan 1.md");
		assertThat(this.dir.resolve("Plan 1.md")).hasContent("old");
		assertThat(this.dir.resolve("Plan.md")).hasContent("new");
	}

	@Test
	void restoreToAnExplicitPathUsesTheNewNameRules() throws Exception {
		create("Plan.md", "old");
		TrashEntry entry = this.vault.trash.deleteFile("Plan.md", TestVault.ALICE, CLIENT);
		assertThatThrownBy(() -> restore(entry.id(), new RestoreRequest("Bad#name.md", null)))
			.isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.INVALID_NAME));
		RestoreResult restored = restore(entry.id(), new RestoreRequest("Kept/Plan (restored).md", null));
		assertThat(restored.path()).isEqualTo("Kept/Plan (restored).md");
		assertThat(restored.createdFolders()).containsExactly("Kept");
	}

	@Test
	void restoringAnOriginalNameThatBreaksTheNewNameRulesWorks() throws Exception {
		writeOnDisk("Plan #2.md", "hash");
		rebuild();
		TrashEntry entry = this.vault.trash.deleteFile("Plan #2.md", TestVault.ALICE, CLIENT);
		RestoreResult restored = restore(entry.id(), null);
		assertThat(restored.path()).isEqualTo("Plan #2.md");
		assertThat(this.dir.resolve("Plan #2.md")).hasContent("hash");
	}

	@Test
	void deletesCommitAnUnreconciledExternalEditFirst() throws Exception {
		create("Plan.md", "v1");
		this.vault.flush();
		writeOnDisk("Plan.md", "edited outside");
		this.vault.trash.deleteFile("Plan.md", TestVault.ALICE, CLIENT);
		List<HistoryEntry> history = this.vault.history.list("Plan.md", 10, 0).entries();
		assertThat(history).extracting(HistoryEntry::message).startsWith("Delete Plan.md", "External changes: 1 file");
		String edit = history.get(1).commitId();
		assertThat(this.vault.git.readAt(edit, "Plan.md").bytes()).asString(StandardCharsets.UTF_8)
			.isEqualTo("edited outside");
	}

	@Test
	void wrongEntryTypesAreRefused() throws Exception {
		create("Folder/x.md", "x");
		assertThatThrownBy(() -> this.vault.trash.deleteFile("Folder", TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		assertThatThrownBy(() -> this.vault.trash.deleteFolder("Folder/x.md", TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		assertThatThrownBy(() -> this.vault.trash.deleteFile("Missing.md", TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
		TrashEntry folder = this.vault.trash.deleteFolder("Folder", TestVault.ALICE, CLIENT);
		assertThatThrownBy(() -> this.vault.trash.openRaw(folder.id())).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		assertThatThrownBy(() -> this.vault.trash.openRaw("0123456789AB")).isInstanceOfSatisfying(
				NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
	}

	@Test
	void trashedFilesCanBeReadRaw() throws Exception {
		create("Note.md", "content");
		TrashEntry entry = this.vault.trash.deleteFile("Note.md", TestVault.ALICE, CLIENT);
		FileService.RawFile raw = this.vault.trash.openRaw(entry.id());
		assertThat(raw.path().name()).isEqualTo("Note.md");
		assertThat(Files.readString(raw.file())).isEqualTo("content");
	}

	@Test
	void externallyAddedItemsAreListedOnceWithAnXId() throws Exception {
		writeOnDisk(".trash/Scratch.md", "scratch");
		writeOnDisk(".trash/Old folder/a.md", "a");
		List<TrashEntry> entries = this.vault.trash.list();
		assertThat(entries).extracting(TrashEntry::originalPath).containsExactlyInAnyOrder("Scratch.md", "Old folder");
		for (TrashEntry entry : entries) {
			assertThat(entry.id()).matches("x-[0-9a-f]{16}");
			assertThat(entry.deletedBy()).isEqualTo("unknown");
		}
		TrashEntry folder = entries.stream().filter((e) -> e.type() == EntryType.FOLDER).findFirst().orElseThrow();
		assertThat(folder.fileCount()).isEqualTo(1);
		RestoreResult restored = restore(entries.stream()
			.filter((e) -> e.originalPath().equals("Scratch.md"))
			.findFirst()
			.orElseThrow()
			.id(), null);
		assertThat(restored.path()).isEqualTo("Scratch.md");
		assertThat(this.vault.trash.list()).hasSize(1);
	}

	@Test
	void metadataEntriesThatPointOutsideTheTrashAreIgnored() throws Exception {
		writeOnDisk("x", "outside");
		writeOnDisk(".trash/a/b", "nested");
		writeOnDisk(".notesapp/trash.json", """
				{"schemaVersion":1,"entries":[
				 {"id":"0123456789AB","originalPath":"Evil.md","trashPath":"../x","type":"file",
				  "deletedAt":"2026-10-16T14:03:22.120Z","deletedBy":"x","size":1,"fileCount":1},
				 {"id":"0123456789AC","originalPath":"Nested.md","trashPath":"a/b","type":"file",
				  "deletedAt":"2026-10-16T14:03:22.120Z","deletedBy":"x","size":1,"fileCount":1}]}
				""");
		List<TrashEntry> entries = this.vault.trash.list();
		assertThat(entries).singleElement().satisfies((entry) -> {
			assertThat(entry.originalPath()).isEqualTo("a");
			assertThat(entry.id()).startsWith("x-");
		});
		assertThatThrownBy(() -> this.vault.trash.purge("0123456789AB")).isInstanceOf(NotesException.class);
		assertThat(this.dir.resolve("x")).exists();
	}

	@Test
	void purgeAndEmptyNeverFollowSymlinks() throws Exception {
		Path outside = Files.createDirectories(this.dir.resolveSibling(this.dir.getFileName() + "-outside"));
		Path precious = Files.writeString(outside.resolve("precious.txt"), "keep me");
		Files.createDirectories(this.dir.resolve(".trash/Folder"));
		try {
			Files.createSymbolicLink(this.dir.resolve(".trash/Folder/link"), outside);
			Files.createSymbolicLink(this.dir.resolve(".trash/top-link"), outside);
		}
		catch (IOException | UnsupportedOperationException ex) {
			assumeTrue(false, "symbolic links are not available: " + ex);
		}
		create("Note.md", "n");
		this.vault.trash.deleteFile("Note.md", TestVault.ALICE, CLIENT);
		TrashEntry folder = this.vault.trash.list()
			.stream()
			.filter((e) -> e.originalPath().equals("Folder"))
			.findFirst()
			.orElseThrow();
		this.vault.trash.purge(folder.id());
		assertThat(precious).hasContent("keep me");
		assertThat(this.vault.trash.empty()).isEqualTo(2);
		assertThat(precious).hasContent("keep me");
		try (var listing = Files.list(this.dir.resolve(".trash"))) {
			assertThat(listing).isEmpty();
		}
		assertThat(this.vault.trash.list()).isEmpty();
	}

	@Test
	void purgeAndEmptyPublishTrashChanged() throws Exception {
		create("a.md", "a");
		create("b.md", "b");
		TrashEntry a = this.vault.trash.deleteFile("a.md", TestVault.ALICE, CLIENT);
		this.vault.trash.deleteFile("b.md", TestVault.ALICE, CLIENT);
		this.vault.hub.published.clear();
		this.vault.trash.purge(a.id());
		assertThat(this.dir.resolve(".trash/a.md")).doesNotExist();
		assertThat(this.vault.trash.empty()).isEqualTo(1);
		assertThat(this.vault.hub.names()).containsExactly("trash.changed", "trash.changed");
		assertThatThrownBy(() -> this.vault.trash.purge(a.id())).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
	}

	@Test
	void foldersWithIgnoredLookingNamesAreListedRestoredAndPurged() throws Exception {
		writeOnDisk("backup.tmp/inside.md", "inside\n");
		rebuild();
		TrashEntry first = this.vault.trash.deleteFolder("backup.tmp", TestVault.ALICE, CLIENT);
		assertThat(this.vault.trash.list()).extracting(TrashEntry::id).containsExactly(first.id());
		writeOnDisk("backup.tmp/other.md", "other\n");
		rebuild();
		TrashEntry second = this.vault.trash.deleteFolder("backup.tmp", TestVault.ALICE, CLIENT);
		assertThat(this.dir.resolve(".trash/backup.tmp/inside.md")).exists();
		assertThat(this.dir.resolve(".trash/backup.tmp 1/other.md")).exists();
		assertThat(this.vault.trash.list()).extracting(TrashEntry::id)
			.containsExactlyInAnyOrder(first.id(), second.id());
		restore(first.id(), null);
		assertThat(this.dir.resolve("backup.tmp/inside.md")).hasContent("inside\n");
		this.vault.trash.purge(second.id());
		assertThat(this.vault.trash.list()).isEmpty();
		assertThat(this.dir.resolve(".trash/backup.tmp 1")).doesNotExist();
	}

	@Test
	void purgeDeletesTheItemAfterReleasingTheLocks() throws Exception {
		CountDownLatch deleting = new CountDownLatch(1);
		CountDownLatch finish = new CountDownLatch(1);
		AtomicBoolean pause = new AtomicBoolean();
		this.vault.close();
		this.vault = TestVault.start(this.dir.resolve("vault"), java.util.Map.of(), (properties) -> new VaultFs(
				properties) {

			@Override
			public void deleteRecursively(Path path) throws IOException {
				if (pause.getAndSet(false)) {
					deleting.countDown();
					try {
						finish.await(30, TimeUnit.SECONDS);
					}
					catch (InterruptedException ex) {
						Thread.currentThread().interrupt();
					}
				}
				super.deleteRecursively(path);
			}

		});
		create("Big/a.md", "a");
		create("Big/b.md", "b");
		create("Other.md", "o");
		TrashEntry big = this.vault.trash.deleteFolder("Big", TestVault.ALICE, CLIENT);
		pause.set(true);
		ExecutorService purger = Executors.newSingleThreadExecutor();
		try {
			Future<?> purge = purger.submit(() -> {
				this.vault.trash.purge(big.id());
				return null;
			});
			assertThat(deleting.await(10, TimeUnit.SECONDS)).isTrue();
			// The purged folder is still being deleted, and the trash and the vault are not waiting for it.
			assertThat(this.vault.trash.list()).isEmpty();
			TrashEntry other = this.vault.trash.deleteFile("Other.md", TestVault.ALICE, CLIENT);
			assertThat(this.vault.trash.list()).extracting(TrashEntry::id).containsExactly(other.id());
			finish.countDown();
			purge.get(10, TimeUnit.SECONDS);
		}
		finally {
			finish.countDown();
			purger.shutdownNow();
		}
		assertThat(this.vault.root.resolve(".trash/Big")).doesNotExist();
		assertThat(this.vault.trash.empty()).isEqualTo(1);
		try (var listing = Files.list(this.vault.root.resolve(".notesapp/tmp"))) {
			assertThat(listing).isEmpty();
		}
		try (var listing = Files.list(this.vault.root.resolve(".trash"))) {
			assertThat(listing).isEmpty();
		}
	}

	@Test
	void trashIsNeverCommitted() throws Exception {
		create("a.md", "a");
		this.vault.trash.deleteFile("a.md", TestVault.ALICE, CLIENT);
		this.vault.git.commitAll((changes) -> new GitStore.Message("All", null), Author.EXTERNAL);
		assertThat(this.vault.git.diskPathAtHead(".trash/a.md")).isNull();
		assertThat(this.vault.git.diskPathAtHead(".notesapp/trash.json")).isNull();
	}

}
