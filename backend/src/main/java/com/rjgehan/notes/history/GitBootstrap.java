package com.rjgehan.notes.history;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.StatusChangedEvent;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * The startup commit, run asynchronously after readiness so a large import never delays the health check (DESIGN
 * §5.17 step 8): {@code Initial commit} for a fresh vault, {@code Import existing vault (N files)} for an existing
 * folder of notes, or {@code Changes made while NotesApp was stopped} when the tree is dirty against {@code HEAD}
 * (or git still tracks a file over the large-file threshold, which stops being tracked). While it runs, history
 * reports {@code importing} and the batcher holds its commits.
 */
@Component
public class GitBootstrap {

	private static final Logger logger = LoggerFactory.getLogger(GitBootstrap.class);

	private final GitStore git;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final Author app;

	private volatile boolean freshVault;

	public GitBootstrap(GitStore git, CommitBatcher batcher, EventHub hub, NotesProperties properties) {
		this.git = git;
		this.batcher = batcher;
		this.hub = hub;
		this.app = new Author(properties.git().committerName(), properties.git().committerEmail());
	}

	/** Set during startup: true when the repository is new and the vault had no files of its own. */
	public void setFreshVault(boolean freshVault) {
		this.freshVault = freshVault;
	}

	@EventListener(ApplicationReadyEvent.class)
	public void onReady() {
		if (!this.git.isEnabled()) {
			return;
		}
		this.batcher.beginImport();
		Thread.ofVirtual().name("git-bootstrap").start(this::run);
	}

	/** Runs the bootstrap commit on the calling thread; the import hold must already be in place. */
	void run() {
		try {
			if (!this.git.hasCommits()) {
				boolean fresh = this.freshVault;
				publish(this.git.commitAll((changes) -> new GitStore.Message(
						fresh ? "Initial commit" : "Import existing vault (" + changes.size() + " files)", null),
						this.app));
			}
			else if (this.git.isDirty() || this.git.tracksLargeFiles()) {
				// A tracked file over the large-file threshold (an imported repository, or a lowered threshold) stops
				// being tracked here; commitAll describes it in the message.
				publish(this.git.commitAll(
						(changes) -> new GitStore.Message("Changes made while NotesApp was stopped",
								CommitBatcher.batchMessage(changes, Author.EXTERNAL).body()),
						Author.EXTERNAL));
			}
		}
		catch (Exception ex) {
			logger.error("GIT_COMMIT_FAILED the startup commit failed; changes stay uncommitted", ex);
		}
		finally {
			this.batcher.endImport();
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.GIT));
		}
	}

	private void publish(GitStore.@Nullable Commit commit) {
		if (commit != null) {
			this.batcher.publishCommitted(commit);
		}
	}

}
