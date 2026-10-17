package com.rjgehan.notes.watch;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Runs the full rescan (DESIGN §5.9) every {@code notes.watcher.rescan-interval}, and on demand after a watcher
 * overflow or at watcher start. Requests coalesce: at most one rescan runs and at most one more is queued, on a single
 * background thread, so neither the scheduler nor the watcher ever waits for a walk.
 */
@Component
public class RescanScheduler implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(RescanScheduler.class);

	/** Starts before the watcher (which asks for a rescan at start) and stops after it. */
	static final int PHASE = DEFAULT_PHASE - 3584;

	private final VaultReconciler reconciler;

	private final AtomicBoolean queued = new AtomicBoolean();

	private final AtomicBoolean overflow = new AtomicBoolean();

	private volatile @Nullable ExecutorService executor;

	public RescanScheduler(VaultReconciler reconciler) {
		this.reconciler = reconciler;
	}

	@Scheduled(fixedDelayString = "${notes.watcher.rescan-interval:5m}",
			initialDelayString = "${notes.watcher.rescan-interval:5m}")
	public void scheduled() {
		request(false);
	}

	/** Queues a rescan; {@code afterOverflow} makes it announce one {@code resync} for everything it finds. */
	public void request(boolean afterOverflow) {
		if (afterOverflow) {
			this.overflow.set(true);
		}
		ExecutorService current = this.executor;
		if (current == null || !this.queued.compareAndSet(false, true)) {
			return;
		}
		current.execute(this::run);
	}

	private void run() {
		this.queued.set(false);
		boolean afterOverflow = this.overflow.getAndSet(false);
		try {
			this.reconciler.fullRescan(afterOverflow);
		}
		catch (RuntimeException ex) {
			logger.warn("The vault rescan failed", ex);
		}
	}

	@Override
	public void start() {
		this.executor = Executors.newSingleThreadExecutor(Thread.ofVirtual().name("vault-rescan").factory());
	}

	@Override
	public void stop() {
		ExecutorService current = this.executor;
		this.executor = null;
		if (current != null) {
			current.shutdown();
			try {
				if (!current.awaitTermination(10, TimeUnit.SECONDS)) {
					current.shutdownNow();
				}
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		}
	}

	@Override
	public boolean isRunning() {
		return this.executor != null;
	}

	@Override
	public int getPhase() {
		return PHASE;
	}

}
