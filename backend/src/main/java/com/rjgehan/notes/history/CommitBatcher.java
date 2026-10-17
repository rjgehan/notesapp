package com.rjgehan.notes.history;

import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.HistoryCommittedEvent;
import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Batches autosaves into debounced commits (DESIGN §5.8): a commit is made once a path has been quiet for
 * {@code commit-quiet-period} or at most {@code commit-max-delay} after the first change. Each batch has one author;
 * {@link #prepareWrite} flushes the batch before a different author writes. Failed commits keep their paths pending
 * and are retried with backoff. The batcher stops after the web server has drained and flushes on the way out.
 * <p>
 * Every commit is announced with {@code history.committed}. Inside an {@link Operation} the announcements wait until
 * the operation closes, so they follow the operation's content and trash events (API.md §16.2), including the commit
 * of a pending batch that the operation forced before it wrote.
 */
@Component
public class CommitBatcher implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(CommitBatcher.class);

	static final int PHASE = DEFAULT_PHASE - 4096;

	private static final List<Duration> BACKOFF = List.of(Duration.ofSeconds(30), Duration.ofMinutes(1),
			Duration.ofMinutes(2), Duration.ofMinutes(5));

	private static final Duration SHUTDOWN_WAIT = Duration.ofSeconds(20);

	/** What {@code /api/status} shows about history. */
	public record Status(int pendingPaths, @Nullable Instant nextCommitAt, @Nullable Instant lastCommitAt,
			@Nullable String lastError, @Nullable Instant failingSince, boolean importing) {
	}

	private final GitStore git;

	private final VaultIndex index;

	private final VaultFs fs;

	private final EventHub hub;

	private final Clock clock;

	private final Duration quietPeriod;

	private final Duration maxDelay;

	private final Object state = new Object();

	private final Map<String, ApiPath> pending = new LinkedHashMap<>();

	private @Nullable Author author;

	/** The author of the batch {@link #flush} is committing right now, or null; guarded by {@link #state}. */
	private @Nullable Author inFlightAuthor;

	private @Nullable Instant firstDirtyAt;

	private @Nullable Instant lastDirtyAt;

	private int failures;

	private @Nullable Instant nextRetryAt;

	private @Nullable Instant failingSince;

	private @Nullable String lastError;

	private @Nullable Instant lastCommitAt;

	private boolean importing;

	private CountDownLatch importDone = new CountDownLatch(0);

	/** Serializes commits; reentrant because an immediate commit flushes the batch first. */
	private final ReentrantLock commitLock = new ReentrantLock();

	private final ThreadLocal<@Nullable Operation> operation = new ThreadLocal<>();

	private volatile @Nullable ScheduledExecutorService ticker;

	public CommitBatcher(GitStore git, VaultIndex index, VaultFs fs, EventHub hub, Clock clock,
			NotesProperties properties) {
		this.git = git;
		this.index = index;
		this.fs = fs;
		this.hub = hub;
		this.clock = clock;
		this.quietPeriod = properties.git().commitQuietPeriod();
		this.maxDelay = properties.git().commitMaxDelay();
	}

	// ---------------------------------------------------------------- batch

	/** Records a changed path; whether it is added or removed is decided at commit time. */
	public void markDirty(ApiPath path, Author changeAuthor) {
		if (!this.git.isEnabled()) {
			return;
		}
		synchronized (this.state) {
			Instant now = this.clock.instant();
			if (this.pending.isEmpty()) {
				this.firstDirtyAt = now;
				this.author = changeAuthor;
			}
			this.pending.put(path.nfc(), path);
			this.lastDirtyAt = now;
		}
	}

	/**
	 * Called under the path lock before a write: when the pending batch belongs to another author, it is committed
	 * first, so the previous author's last version is committed under their name and the new bytes are not. A batch of
	 * another author that is being committed right now counts too: its {@code git add} reads the disk, so the write
	 * waits until that commit is done. Commits never take vault or path locks, so waiting here cannot deadlock.
	 */
	public void prepareWrite(Author writer) {
		while (true) {
			boolean otherPending;
			boolean otherInFlight;
			synchronized (this.state) {
				otherPending = !this.pending.isEmpty() && this.author != null && !this.author.equals(writer);
				otherInFlight = this.inFlightAuthor != null && !this.inFlightAuthor.equals(writer);
			}
			if (otherPending) {
				try {
					// Waits for any commit in progress (commitLock), then commits the other author's batch.
					flush();
				}
				catch (CommitFailedException ex) {
					logger.debug("Flushing the previous author's batch failed; it stays pending", ex);
				}
				return;
			}
			if (!otherInFlight) {
				return;
			}
			this.commitLock.lock();
			this.commitLock.unlock();
		}
	}

	/**
	 * A mutating API operation on the calling thread (save, delete, move, restore, ...). While it is open, the
	 * {@code history.committed} events of the commits made on this thread are held back; closing it publishes them in
	 * commit order. Operations nest, and only the outermost one publishes. Open it before taking the operation's locks,
	 * so it closes after them.
	 */
	public Operation beginOperation() {
		Operation current = this.operation.get();
		if (current != null) {
			current.depth++;
			return current;
		}
		Operation started = new Operation();
		this.operation.set(started);
		return started;
	}

	/** See {@link #beginOperation()}. */
	public final class Operation implements AutoCloseable {

		private final List<GitStore.Commit> commits = new ArrayList<>();

		private int depth = 1;

		private Operation() {
		}

		@Override
		public void close() {
			if (--this.depth > 0) {
				return;
			}
			CommitBatcher.this.operation.remove();
			this.commits.forEach(CommitBatcher.this::publishCommitted);
		}

	}

	/** Announces a commit now, or when the operation running on this thread closes. */
	private void announce(GitStore.Commit commit) {
		Operation current = this.operation.get();
		if (current != null) {
			current.commits.add(commit);
		}
		else {
			publishCommitted(commit);
		}
	}

	/**
	 * Commits every pending path now. Returns the commit, or null when nothing was pending, nothing changed, history is
	 * disabled, or the startup import is still running. Announces {@code history.committed} for a commit it makes.
	 * @throws CommitFailedException when git is enabled and the commit failed (the paths stay pending)
	 */
	public GitStore.@Nullable Commit flush() {
		this.commitLock.lock();
		try {
			List<ApiPath> paths;
			Author batchAuthor;
			synchronized (this.state) {
				if (this.pending.isEmpty() || this.importing || !this.git.isEnabled()) {
					return null;
				}
				paths = new ArrayList<>(this.pending.values());
				batchAuthor = (this.author != null) ? this.author : Author.EXTERNAL;
				clearPending();
				this.inFlightAuthor = batchAuthor;
			}
			GitStore.Commit commit;
			try {
				commit = commitPaths(paths, (changes) -> batchMessage(changes, batchAuthor), batchAuthor);
			}
			catch (Exception ex) {
				addPending(paths, batchAuthor);
				failed(ex);
				throw new CommitFailedException(ex);
			}
			succeeded();
			if (commit != null) {
				announce(commit);
			}
			return commit;
		}
		finally {
			synchronized (this.state) {
				this.inFlightAuthor = null;
			}
			this.commitLock.unlock();
		}
	}

	/**
	 * An immediate commit (delete, move, restore): flushes the pending batch under its own message, then commits
	 * {@code paths}. Returns null when nothing changed or the commit failed; a failed commit leaves its paths pending
	 * and the operation still succeeds. Callers run inside an {@link Operation}, so {@code history.committed} follows
	 * their content events.
	 */
	public GitStore.@Nullable Commit commitNow(String subject, @Nullable String body, Author commitAuthor,
			Collection<ApiPath> paths) {
		this.commitLock.lock();
		try {
			try {
				flush();
			}
			catch (CommitFailedException ex) {
				addPending(paths, commitAuthor);
				return null;
			}
			if (!this.git.isEnabled()) {
				return null;
			}
			boolean hold;
			synchronized (this.state) {
				hold = this.importing;
			}
			if (hold) {
				addPending(paths, commitAuthor);
				return null;
			}
			try {
				GitStore.Commit commit = commitPaths(paths, (changes) -> new GitStore.Message(subject, body),
						commitAuthor);
				succeeded();
				if (commit != null) {
					announce(commit);
				}
				return commit;
			}
			catch (Exception ex) {
				addPending(paths, commitAuthor);
				failed(ex);
				return null;
			}
		}
		finally {
			this.commitLock.unlock();
		}
	}

	/** Publishes {@code history.committed} for a commit made outside the batcher (the startup bootstrap commit). */
	public void publishCommitted(GitStore.Commit commit) {
		List<String> paths = commit.paths();
		boolean truncated = paths.size() > HistoryCommittedEvent.MAX_PATHS;
		this.hub.publish(new HistoryCommittedEvent(commit.id(), commit.subject(), commit.author().name(),
				commit.time(), truncated ? List.copyOf(paths.subList(0, HistoryCommittedEvent.MAX_PATHS)) : paths,
				truncated));
	}

	public boolean isPending(String path) {
		synchronized (this.state) {
			return this.pending.containsKey(path);
		}
	}

	public Status status() {
		synchronized (this.state) {
			return new Status(this.pending.size(), nextCommitAt(), this.lastCommitAt, this.lastError,
					this.failingSince, this.importing);
		}
	}

	public boolean isFailing() {
		synchronized (this.state) {
			return this.failures > 0;
		}
	}

	// ---------------------------------------------------------------- startup import

	/** Holds commits while the startup import runs; saves keep being recorded. */
	public void beginImport() {
		synchronized (this.state) {
			this.importing = true;
			this.importDone = new CountDownLatch(1);
		}
	}

	public void endImport() {
		synchronized (this.state) {
			this.importing = false;
			this.importDone.countDown();
		}
	}

	public boolean isImporting() {
		synchronized (this.state) {
			return this.importing;
		}
	}

	// ---------------------------------------------------------------- tick

	/**
	 * Commits the batch when it is due: quiet long enough, or old enough, or a retry is due after a failure. Never
	 * throws: an exception escaping a scheduled task would cancel the ticker, and autosaves would never be committed
	 * again.
	 */
	void tick() {
		try {
			if (isDue()) {
				flush();
			}
		}
		catch (CommitFailedException ex) {
			// Logged once per failure streak by failed(); the batcher retries with backoff.
		}
		catch (RuntimeException | Error ex) {
			logger.error("The commit batcher's tick failed; it will run again", ex);
		}
	}

	boolean isDue() {
		synchronized (this.state) {
			if (this.pending.isEmpty() || this.importing || !this.git.isEnabled()) {
				return false;
			}
			Instant now = this.clock.instant();
			if (this.failures > 0) {
				return this.nextRetryAt == null || !now.isBefore(this.nextRetryAt);
			}
			Instant due = nextCommitAt();
			return due != null && !now.isBefore(due);
		}
	}

	private @Nullable Instant nextCommitAt() {
		if (this.pending.isEmpty() || this.lastDirtyAt == null || this.firstDirtyAt == null) {
			return null;
		}
		if (this.failures > 0 && this.nextRetryAt != null) {
			return this.nextRetryAt;
		}
		Instant quiet = this.lastDirtyAt.plus(this.quietPeriod);
		Instant max = this.firstDirtyAt.plus(this.maxDelay);
		return quiet.isBefore(max) ? quiet : max;
	}

	// ---------------------------------------------------------------- lifecycle

	@Override
	public void start() {
		ScheduledExecutorService executor = Executors
			.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("commit-batcher").daemon().factory());
		executor.scheduleWithFixedDelay(this::tick, 1, 1, TimeUnit.SECONDS);
		this.ticker = executor;
	}

	@Override
	public void stop() {
		ScheduledExecutorService executor = this.ticker;
		this.ticker = null;
		if (executor != null) {
			executor.shutdownNow();
		}
		CountDownLatch done;
		synchronized (this.state) {
			done = this.importDone;
		}
		try {
			if (!done.await(SHUTDOWN_WAIT.toMillis(), TimeUnit.MILLISECONDS)) {
				logger.warn("The startup git import is still running at shutdown");
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
		try {
			flush();
		}
		catch (CommitFailedException ex) {
			logger.error("GIT_COMMIT_FAILED pending changes could not be committed at shutdown: {}", ex.getMessage());
		}
	}

	@Override
	public boolean isRunning() {
		return this.ticker != null;
	}

	@Override
	public int getPhase() {
		return PHASE;
	}

	// ---------------------------------------------------------------- internals

	private GitStore.@Nullable Commit commitPaths(Collection<ApiPath> paths,
			Function<List<GitStore.Change>, GitStore.Message> message, Author commitAuthor)
			throws Exception {
		List<ApiPath> present = new ArrayList<>();
		List<ApiPath> removed = new ArrayList<>();
		for (ApiPath path : paths) {
			(isPresent(path) ? present : removed).add(path);
		}
		return this.git.commit(present, removed, message, commitAuthor);
	}

	/**
	 * Present in the index (as a file or folder) and on disk under that on-disk name. Hidden app files such as
	 * {@code .notesapp/settings.json} are never indexed, so for them the disk alone decides.
	 */
	private boolean isPresent(ApiPath path) {
		boolean hidden = path.nfc().startsWith(".");
		boolean indexed = hidden || this.index.file(path.nfc()) != null || this.index.isFolder(path.nfc());
		if (!indexed) {
			return false;
		}
		BasicFileAttributes attributes = this.fs.attributes(path.disk());
		return attributes != null && !attributes.isSymbolicLink();
	}

	private void clearPending() {
		this.pending.clear();
		this.author = null;
		this.firstDirtyAt = null;
		this.lastDirtyAt = null;
	}

	/**
	 * Adds paths back to the batch (a failed commit), keeping anything marked dirty meanwhile. A batch has one author:
	 * when the paths marked dirty meanwhile are External changes, the app author of the failed paths takes the batch,
	 * because External attribution is best-effort (DESIGN §5.8) while an app author's edit must keep its name.
	 */
	private void addPending(Collection<ApiPath> paths, Author pathsAuthor) {
		synchronized (this.state) {
			Instant now = this.clock.instant();
			if (this.pending.isEmpty()) {
				this.author = pathsAuthor;
				this.firstDirtyAt = now;
				this.lastDirtyAt = now;
			}
			else if (Author.EXTERNAL.equals(this.author) && !Author.EXTERNAL.equals(pathsAuthor)) {
				this.author = pathsAuthor;
			}
			Map<String, ApiPath> merged = new LinkedHashMap<>();
			paths.forEach((path) -> merged.put(path.nfc(), path));
			merged.putAll(this.pending);
			this.pending.clear();
			this.pending.putAll(merged);
		}
	}

	private void succeeded() {
		boolean recovered;
		synchronized (this.state) {
			recovered = this.failures > 0;
			this.failures = 0;
			this.nextRetryAt = null;
			this.failingSince = null;
			this.lastError = null;
			this.lastCommitAt = this.clock.instant();
		}
		if (recovered) {
			logger.info("Git commits are working again");
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.GIT));
		}
	}

	private void failed(Exception ex) {
		boolean firstFailure;
		synchronized (this.state) {
			Instant now = this.clock.instant();
			firstFailure = this.failures == 0;
			this.failures++;
			if (firstFailure) {
				this.failingSince = now;
			}
			this.lastError = String.valueOf(ex.getMessage());
			this.nextRetryAt = now.plus(BACKOFF.get(Math.min(this.failures, BACKOFF.size()) - 1));
		}
		if (firstFailure) {
			logger.error("GIT_COMMIT_FAILED history is not being saved; retrying with backoff", ex);
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.GIT));
		}
		else {
			logger.debug("Git commit failed again", ex);
		}
	}

	static GitStore.Message batchMessage(List<GitStore.Change> changes, Author batchAuthor) {
		int count = changes.size();
		String body = changes.stream().map((c) -> letter(c.type()) + " " + c.path()).collect(Collectors.joining("\n"));
		if (Author.EXTERNAL.equals(batchAuthor)) {
			return new GitStore.Message("External changes: " + count + ((count == 1) ? " file" : " files"), body);
		}
		if (count == 1) {
			GitStore.Change change = changes.get(0);
			String verb = switch (change.type()) {
				case ADDED -> "Create ";
				case DELETED -> "Delete ";
				default -> "Update ";
			};
			return new GitStore.Message(verb + change.path(), null);
		}
		String names = changes.stream().limit(3).map(GitStore.Change::path).collect(Collectors.joining(", "));
		String more = (count > 3) ? " (+" + (count - 3) + " more)" : "";
		return new GitStore.Message("Update " + count + " files: " + names + more, body);
	}

	private static String letter(ChangeType type) {
		return switch (type) {
			case ADDED -> "A";
			case DELETED -> "D";
			case RENAMED -> "R";
			case MODIFIED -> "M";
		};
	}

}
