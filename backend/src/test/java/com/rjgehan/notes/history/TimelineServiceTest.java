package com.rjgehan.notes.history;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.api.dto.ChangesResponse;
import com.rjgehan.notes.api.dto.DeletedFile;
import com.rjgehan.notes.api.dto.DeletedFilesResponse;
import com.rjgehan.notes.api.dto.HistoryRestoreRequest;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.TimelineEntry;
import com.rjgehan.notes.api.dto.TimelineFile;
import com.rjgehan.notes.api.dto.TimelineResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.ApiPath;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

/** The vault-wide timeline, changes over a period, and deleted files (ROADMAP item 28). */
class TimelineServiceTest {

	private static final Instant START = Instant.parse("2026-10-16T12:00:00Z");

	@TempDir
	Path dir;

	private TestVault vault;

	private TimelineService timeline;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.timeline = new TimelineService(this.vault.git, new GitTimeline(this.vault.git), this.vault.batcher,
				this.vault.index, this.vault.paths);
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
		return this.vault.files.saveText(path, content, base, false, TestVault.BOB, "client-b1")
			.result()
			.file()
			.version();
	}

	private GitStore.Commit commit() {
		GitStore.Commit commit = this.vault.flush();
		this.vault.clock.advance(Duration.ofDays(1));
		return commit;
	}

	private void delete(String path) throws Exception {
		Files.delete(this.dir.resolve(path));
		this.vault.index.removeFile(path);
		this.vault.batcher.commitNow("Delete " + path, null, Author.of(TestVault.ALICE), List.of(ApiPath.of(path)));
		this.vault.clock.advance(Duration.ofDays(1));
	}

	private void rename(String from, String to) throws Exception {
		Files.createDirectories(this.dir.resolve(to).getParent());
		Files.move(this.dir.resolve(from), this.dir.resolve(to));
		this.vault.index.removeFile(from);
		this.vault.files.indexFromDisk(ApiPath.of(to));
		this.vault.batcher.commitNow("Rename " + from + " → " + to, null, Author.of(TestVault.ALICE),
				List.of(ApiPath.of(from), ApiPath.of(to)));
		this.vault.clock.advance(Duration.ofDays(1));
	}

	/** Day 0: a, b; day 1: b edited by Bob; day 2: b renamed to Docs/b2; day 3: a deleted. */
	private void history() throws Exception {
		create("a.md", "alpha\n");
		String b = create("b.md", "bravo, long enough to keep its identity on a rename\n");
		commit();
		save("b.md", "bravo, long enough to keep its identity on a rename\nmore\n", b);
		commit();
		rename("b.md", "Docs/b2.md");
		delete("a.md");
	}

	private static List<String> messages(TimelineResponse response) {
		return response.entries().stream().map(TimelineEntry::message).toList();
	}

	@Test
	void theTimelineListsEveryCommitWithItsFiles() throws Exception {
		history();
		TimelineResponse all = this.timeline.log(null, null, null, null, 50, 0);
		assertThat(messages(all)).containsExactly("Delete a.md", "Rename b.md → Docs/b2.md", "Update b.md",
				"Update 2 files: a.md, b.md");
		assertThat(all.entries().get(0).files()).containsExactly(new TimelineFile("a.md", ChangeType.DELETED, null));
		assertThat(all.entries().get(1).files())
			.containsExactly(new TimelineFile("Docs/b2.md", ChangeType.RENAMED, "b.md"));
		assertThat(all.entries().get(2).authorLogin()).isEqualTo("bob@github");
		TimelineEntry first = all.entries().get(3);
		assertThat(first.parentCommitId()).isNull();
		assertThat(first.files()).extracting(TimelineFile::change).containsOnly(ChangeType.ADDED);
		assertThat(first.filesTotal()).isEqualTo(2);
		assertThat(all.hasMore()).isFalse();

		TimelineResponse page = this.timeline.log(null, null, null, null, 2, 1);
		assertThat(messages(page)).containsExactly("Rename b.md → Docs/b2.md", "Update b.md");
		assertThat(page.hasMore()).isTrue();
	}

	@Test
	void theTimelineFiltersByPathAuthorAndTime() throws Exception {
		history();
		assertThat(messages(this.timeline.log("Docs", null, null, null, 50, 0)))
			.containsExactly("Rename b.md → Docs/b2.md");
		assertThat(messages(this.timeline.log("a.md", null, null, null, 50, 0))).containsExactly("Delete a.md",
				"Update 2 files: a.md, b.md");
		assertThat(messages(this.timeline.log(null, "BOB", null, null, 50, 0))).containsExactly("Update b.md");
		Instant day1 = START.plus(Duration.ofDays(1));
		Instant day3 = START.plus(Duration.ofDays(3));
		assertThat(messages(this.timeline.log(null, null, day1.toString(), day3.toString(), 50, 0)))
			.containsExactly("Rename b.md → Docs/b2.md", "Update b.md");
		NotesException bad = catchThrowableOfType(NotesException.class,
				() -> this.timeline.log(null, null, "yesterday", null, 50, 0));
		assertThat(bad.code()).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void changesOverAPeriodAreTheNetDifference() throws Exception {
		history();
		Instant day1 = START.plus(Duration.ofDays(1));
		ChangesResponse week = this.timeline.changes(day1.toString(), null, null);
		assertThat(week.commits()).isEqualTo(3);
		assertThat(week.authors()).containsExactlyInAnyOrder("Alice", "Bob");
		assertThat(week.files()).containsExactly(new TimelineFile("a.md", ChangeType.DELETED, null),
				new TimelineFile("Docs/b2.md", ChangeType.RENAMED, "b.md"));
		assertThat(week.fromCommitId()).isNotNull();
		assertThat(this.vault.git.readAt(week.fromCommitId(), "b.md")).isNotNull();

		ChangesResponse everything = this.timeline.changes(null, null, null);
		assertThat(everything.fromCommitId()).isNull();
		assertThat(everything.files()).containsExactly(new TimelineFile("Docs/b2.md", ChangeType.ADDED, null));

		ChangesResponse none = this.timeline.changes(START.plus(Duration.ofDays(30)).toString(), null, null);
		assertThat(none.commits()).isZero();
		assertThat(none.files()).isEmpty();
	}

	@Test
	void deletedFilesCanBeListedAndRestoredFromGit() throws Exception {
		history();
		create("Keep/c.md", "charlie\n");
		commit();
		delete("Keep/c.md");
		DeletedFilesResponse deleted = this.timeline.deleted(null, 50, 0);
		assertThat(deleted.entries()).extracting(DeletedFile::path).containsExactly("Keep/c.md", "a.md");
		assertThat(deleted.total()).isEqualTo(2);
		DeletedFile a = deleted.entries().get(1);
		assertThat(a.message()).isEqualTo("Delete a.md");
		assertThat(this.timeline.deleted("KEEP", 50, 0).entries()).extracting(DeletedFile::path)
			.containsExactly("Keep/c.md");
		assertThat(this.timeline.deleted(null, 1, 1).entries()).extracting(DeletedFile::path)
			.containsExactly("a.md");

		// Restoring from git brings the file back; it is then no longer listed (incremental update).
		this.vault.history.restore(new HistoryRestoreRequest("a.md", a.parentCommitId(), "a.md", null),
				TestVault.ALICE, "client-a1");
		assertThat(Files.readString(this.dir.resolve("a.md"))).isEqualTo("alpha\n");
		assertThat(this.timeline.deleted(null, 50, 0).entries()).extracting(DeletedFile::path)
			.containsExactly("Keep/c.md");
		// Renamed files are not deleted files.
		assertThat(this.timeline.deleted("b.md", 50, 0).entries()).isEmpty();
		// Deleted again later: listed again, with the newest deletion.
		delete("a.md");
		assertThat(this.timeline.deleted("a.md", 50, 0).entries()).singleElement()
			.satisfies((entry) -> assertThat(entry.deletedAt()).isAfter(a.deletedAt()));
	}

	@Test
	void historyMustBeAvailable() {
		this.vault.git.close();
		NotesException unavailable = catchThrowableOfType(NotesException.class,
				() -> this.timeline.log(null, null, null, null, 50, 0));
		assertThat(unavailable.code()).isEqualTo(ErrorCode.HISTORY_UNAVAILABLE);
	}

}
