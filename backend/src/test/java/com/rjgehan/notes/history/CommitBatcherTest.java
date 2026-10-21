package com.rjgehan.notes.history;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Normalizer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.events.HistoryCommittedEvent;
import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.ApiPath;
import org.eclipse.jgit.revwalk.RevCommit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CommitBatcherTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private CommitBatcher batcher;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.batcher = this.vault.batcher;
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private String write(String path, String content) throws Exception {
		return this.vault.files.createText(path, content, OnConflict.FAIL, TestVault.ALICE, "client-a1")
			.file()
			.version();
	}

	private List<RevCommit> commits(String path) throws Exception {
		return this.vault.git.log(path, 0, 50).entries().stream().map(GitStore.LogEntry::commit).toList();
	}

	private long committedEvents() {
		return this.vault.hub.published.stream().filter(HistoryCommittedEvent.class::isInstance).count();
	}

	@Test
	void commitsAfterTheQuietPeriod() throws Exception {
		write("a.md", "a");
		this.vault.clock.advance(Duration.ofSeconds(29));
		this.batcher.tick();
		assertThat(this.vault.git.head()).isNull();
		this.vault.clock.advance(Duration.ofSeconds(1));
		this.batcher.tick();
		assertThat(this.vault.git.head()).isNotNull();
		assertThat(commits("a.md").get(0).getShortMessage()).isEqualTo("Create a.md");
		assertThat(committedEvents()).isEqualTo(1);
	}

	@Test
	void commitsAfterTheMaximumDelayEvenWhileEditsContinue() throws Exception {
		String version = write("busy.md", "0");
		for (int i = 1; i <= 29; i++) {
			this.vault.clock.advance(Duration.ofSeconds(10));
			version = this.vault.files.saveText("busy.md", String.valueOf(i), version, false, TestVault.ALICE,
					"client-a1").result().file().version();
			this.batcher.tick();
			assertThat(this.vault.git.head()).as("after %d edits", i).isNull();
		}
		this.vault.clock.advance(Duration.ofSeconds(10));
		this.batcher.tick();
		assertThat(this.vault.git.head()).isNotNull();
	}

	@Test
	void anotherAuthorsBatchIsFlushedBeforeTheWrite() throws Exception {
		String version = write("shared.md", "alice's text");
		this.vault.files.saveText("shared.md", "bob's text", version, false, TestVault.BOB, "client-b2");
		List<RevCommit> log = commits("shared.md");
		assertThat(log).hasSize(1);
		assertThat(log.get(0).getAuthorIdent().getName()).isEqualTo("Alice");
		assertThat(new String(this.vault.git.readAt(log.get(0).name(), "shared.md").bytes(), StandardCharsets.UTF_8))
			.isEqualTo("alice's text");
		this.vault.flush();
		assertThat(commits("shared.md").get(0).getAuthorIdent().getName()).isEqualTo("Bob");
	}

	@Test
	void anotherAuthorsWriteWaitsForTheBatchCommitInProgress() throws Exception {
		String version = write("P.md", "alice text");
		CountDownLatch committing = new CountDownLatch(1);
		CountDownLatch resume = new CountDownLatch(1);
		this.vault.git.beforeCommit = () -> {
			committing.countDown();
			try {
				resume.await(30, TimeUnit.SECONDS);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		};
		ExecutorService threads = Executors.newFixedThreadPool(2);
		try {
			// The tick's flush stops inside the commit, before its git add has read P.md.
			Future<GitStore.Commit> tick = threads.submit(() -> this.vault.flush());
			assertThat(committing.await(10, TimeUnit.SECONDS)).isTrue();
			this.vault.git.beforeCommit = () -> {
			};
			Future<?> bobSaves = threads.submit(() -> this.vault.files.saveText("P.md", "bob text", version, false,
					TestVault.BOB, "client-b2"));
			assertThatThrownBy(() -> bobSaves.get(500, TimeUnit.MILLISECONDS))
				.as("Bob's write waits for Alice's commit")
				.isInstanceOf(TimeoutException.class);
			resume.countDown();
			GitStore.Commit alices = tick.get(10, TimeUnit.SECONDS);
			bobSaves.get(10, TimeUnit.SECONDS);
			assertThat(alices.author().name()).isEqualTo("Alice");
			assertThat(new String(this.vault.git.readAt(alices.id(), "P.md").bytes(), StandardCharsets.UTF_8))
				.isEqualTo("alice text");
		}
		finally {
			resume.countDown();
			threads.shutdownNow();
		}
		GitStore.Commit bobs = this.vault.flush();
		assertThat(bobs).isNotNull();
		assertThat(bobs.author().name()).isEqualTo("Bob");
		assertThat(new String(this.vault.git.readAt(bobs.id(), "P.md").bytes(), StandardCharsets.UTF_8))
			.isEqualTo("bob text");
	}

	@Test
	void aFailedBatchKeepsItsAppAuthorWhenExternalChangesArrivedMeanwhile() throws Exception {
		write("app.md", "alice's edit");
		this.vault.git.failing = true;
		this.vault.git.beforeCommit = () -> this.batcher.markDirty(this.vault.path("app.md"), Author.EXTERNAL);
		assertThatThrownBy(this.vault::flush).isInstanceOf(CommitFailedException.class);
		this.vault.git.beforeCommit = () -> {
		};
		this.vault.git.failing = false;
		GitStore.Commit retried = this.vault.flush();
		assertThat(retried.author().name()).isEqualTo("Alice");
	}

	@Test
	void aTickNeverThrowsSoTheTickerIsNeverCancelled() throws Exception {
		write("x.md", "x");
		this.vault.git.failing = true;
		this.vault.hub.failing = StatusChangedEvent.class::isInstance;
		this.vault.clock.advance(Duration.ofSeconds(30));
		assertThatCode(this.batcher::tick).doesNotThrowAnyException();
		assertThat(this.batcher.isPending("x.md")).isTrue();
		this.vault.hub.failing = (event) -> false;
		this.vault.git.failing = false;
		this.vault.clock.advance(Duration.ofMinutes(1));
		this.batcher.tick();
		assertThat(this.batcher.isPending("x.md")).isFalse();
		assertThat(commits("x.md")).hasSize(1);
	}

	@Test
	void noEmptyCommitsAndNoEventsForThem() throws Exception {
		write("same.md", "x");
		this.vault.flush();
		long events = committedEvents();
		this.batcher.markDirty(this.vault.path("same.md"), Author.of(TestVault.ALICE));
		assertThat(this.vault.flush()).isNull();
		assertThat(committedEvents()).isEqualTo(events);
		assertThat(this.batcher.isPending("same.md")).isFalse();
	}

	@Test
	void anOperationAnnouncesItsCommitsWhenItCloses() throws Exception {
		write("first.md", "x");
		long before = committedEvents();
		GitStore.Commit flushed;
		GitStore.Commit immediate;
		try (CommitBatcher.Operation outer = this.batcher.beginOperation()) {
			try (CommitBatcher.Operation inner = this.batcher.beginOperation()) {
				flushed = this.vault.flush();
			}
			Files.delete(this.dir.resolve("first.md"));
			this.vault.index.removeFile("first.md");
			immediate = this.batcher.commitNow("Delete first.md", null, Author.of(TestVault.ALICE),
					List.of(new ApiPath("first.md", "first.md")));
			assertThat(flushed).isNotNull();
			assertThat(immediate).isNotNull();
			assertThat(committedEvents()).as("held until the outermost operation closes").isEqualTo(before);
		}
		List<String> announced = this.vault.hub.published.stream()
			.filter(HistoryCommittedEvent.class::isInstance)
			.map((event) -> ((HistoryCommittedEvent) event).commitId())
			.toList();
		assertThat(announced).endsWith(flushed.id(), immediate.id());

		write("later.md", "y");
		GitStore.Commit outside = this.vault.flush();
		assertThat(this.vault.hub.published.get(this.vault.hub.published.size() - 1))
			.isEqualTo(new HistoryCommittedEvent(outside.id(), outside.subject(), outside.author().name(),
					outside.time(), outside.paths(), false));
	}

	@Test
	void immediateCommitsFlushTheBatchFirst() throws Exception {
		write("other.md", "x");
		this.vault.flush();
		write("pending.md", "edit");
		Files.delete(this.dir.resolve("other.md"));
		this.vault.index.removeFile("other.md");
		GitStore.Commit immediate = this.batcher.commitNow("Delete other.md", null, Author.of(TestVault.ALICE),
				List.of(new ApiPath("other.md", "other.md")));
		assertThat(immediate).isNotNull();
		assertThat(immediate.subject()).isEqualTo("Delete other.md");
		assertThat(immediate.paths()).containsExactly("other.md");
		List<RevCommit> pendingLog = commits("pending.md");
		assertThat(pendingLog).hasSize(1);
		assertThat(pendingLog.get(0).getShortMessage()).isEqualTo("Create pending.md");
		assertThat(pendingLog.get(0).name()).isNotEqualTo(immediate.id());
		assertThat(this.vault.git.log("other.md", 0, 10).entries().get(0).change())
			.isEqualTo(com.rjgehan.notes.api.dto.ChangeType.DELETED);
	}

	@Test
	void stopFlushesThePendingBatch() throws Exception {
		write("last.md", "words");
		this.batcher.start();
		this.batcher.stop();
		assertThat(commits("last.md")).hasSize(1);
		assertThat(this.batcher.isRunning()).isFalse();
	}

	@Test
	void failedCommitsStayPendingRetryWithBackoffAndRecover() throws Exception {
		write("x.md", "x");
		this.vault.git.failing = true;
		this.vault.clock.advance(Duration.ofSeconds(30));
		this.batcher.tick();
		CommitBatcher.Status failing = this.batcher.status();
		assertThat(failing.failingSince()).isNotNull();
		assertThat(failing.lastError()).contains("disk full");
		assertThat(this.batcher.isPending("x.md")).isTrue();
		assertThat(this.vault.hub.published).filteredOn(StatusChangedEvent.class::isInstance).hasSize(1);

		this.vault.clock.advance(Duration.ofSeconds(29));
		assertThat(this.batcher.isDue()).isFalse();
		this.vault.clock.advance(Duration.ofSeconds(1));
		assertThat(this.batcher.isDue()).isTrue();
		this.batcher.tick();
		assertThat(this.batcher.status().nextCommitAt()).isEqualTo(this.vault.clock.instant().plus(Duration.ofMinutes(1)));
		assertThat(this.vault.hub.published).filteredOn(StatusChangedEvent.class::isInstance).hasSize(1);

		this.vault.git.failing = false;
		this.vault.clock.advance(Duration.ofMinutes(1));
		this.batcher.tick();
		assertThat(this.batcher.isPending("x.md")).isFalse();
		assertThat(this.batcher.status().failingSince()).isNull();
		assertThat(this.batcher.status().lastError()).isNull();
		assertThat(this.vault.hub.published).filteredOn(StatusChangedEvent.class::isInstance).hasSize(2);
		assertThat(commits("x.md")).hasSize(1);
		// The status page's counters for this run: two failed attempts, then one commit.
		assertThat(this.batcher.status().failedCommitsThisRun()).isEqualTo(2);
		assertThat(this.batcher.status().commitsThisRun()).isEqualTo(1);
	}

	@Test
	void nfdOnDiskNamesAreStagedAndCommitted() throws Exception {
		String nfd = Normalizer.normalize("Café.md", Normalizer.Form.NFD);
		Files.writeString(this.dir.resolve(nfd), "before");
		this.vault.builder.build();
		assertThat(this.vault.index.diskPath("Café.md")).isEqualTo(nfd);
		String version = this.vault.index.file("Café.md").version();
		this.vault.files.saveText("Café.md", "after", version, false, TestVault.ALICE, "client-a1");
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit).isNotNull();
		assertThat(commit.paths()).contains("Café.md");
		assertThat(new String(this.vault.git.readAt(commit.id(), "Café.md").bytes(), StandardCharsets.UTF_8))
			.isEqualTo("after");
		assertThat(this.vault.git.readAt(commit.id(), nfd)).isNotNull();
	}

	@Test
	void batchMessages() {
		Author alice = Author.of(TestVault.ALICE);
		assertThat(CommitBatcher.batchMessage(List.of(change("A", "Ideas.md")), alice).subject())
			.isEqualTo("Create Ideas.md");
		assertThat(CommitBatcher.batchMessage(List.of(change("M", "Plan.md")), alice).subject())
			.isEqualTo("Update Plan.md");
		GitStore.Message many = CommitBatcher.batchMessage(
				List.of(change("A", "a.md"), change("M", "b.md"), change("D", "c.md"), change("M", "d.md")), alice);
		assertThat(many.subject()).isEqualTo("Update 4 files: a.md, b.md, c.md (+1 more)");
		assertThat(many.body()).isEqualTo("A a.md\nM b.md\nD c.md\nM d.md");
		assertThat(CommitBatcher.batchMessage(List.of(change("M", "a.md"), change("M", "b.md")), Author.EXTERNAL)
			.subject()).isEqualTo("External changes: 2 files");
		assertThat(GitStore.truncate("x".repeat(200))).hasSize(120);
	}

	private static GitStore.Change change(String letter, String path) {
		return new GitStore.Change(switch (letter) {
			case "A" -> com.rjgehan.notes.api.dto.ChangeType.ADDED;
			case "D" -> com.rjgehan.notes.api.dto.ChangeType.DELETED;
			default -> com.rjgehan.notes.api.dto.ChangeType.MODIFIED;
		}, path);
	}

	@Test
	void importHoldsCommits() throws Exception {
		this.batcher.beginImport();
		write("held.md", "x");
		assertThat(this.vault.flush()).isNull();
		assertThat(this.batcher.commitNow("Delete held.md", null, Author.EXTERNAL, List.of(new ApiPath("held.md",
				"held.md")))).isNull();
		assertThat(this.batcher.isPending("held.md")).isTrue();
		this.batcher.endImport();
		assertThat(this.vault.flush()).isNotNull();
	}

}
