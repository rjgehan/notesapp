package com.rjgehan.notes.watch;

import java.io.IOException;
import java.nio.file.ClosedWatchServiceException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.Normalizer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.api.dto.WatcherMode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Watches the vault for external changes (DESIGN §5.9): every folder is registered with the JDK {@link WatchService}
 * (inotify on Linux), skipping hidden folders; each event re-arms a per-path debounce deadline, and a 100 ms ticker
 * reconciles paths whose deadline has passed. A new folder is registered and then reconciled as a whole, which covers
 * files created before its watch existed; a deleted folder's keys are cancelled. An overflow or an unknown key asks
 * for a full rescan. When registration fails (for example the inotify watch limit), the watcher degrades to polling
 * mode and the periodic rescan carries on alone; on Windows it starts in that mode. Starts after the commit batcher
 * and before Tomcat.
 */
@Component
public class VaultWatcher implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(VaultWatcher.class);

	static final int PHASE = DEFAULT_PHASE - 3072;

	private static final long TICK_MILLIS = 100;

	private static final boolean WINDOWS = System.getProperty("os.name", "").startsWith("Windows");

	private final VaultFs fs;

	private final VaultReconciler reconciler;

	private final RescanScheduler rescans;

	private final EventHub hub;

	private final boolean enabled;

	private final long debounceNanos;

	private final Map<WatchKey, Path> keys = new ConcurrentHashMap<>();

	private final Map<String, Long> deadlines = new ConcurrentHashMap<>();

	private volatile WatcherMode mode = WatcherMode.DISABLED;

	private volatile boolean running;

	private volatile @Nullable WatchService service;

	private volatile @Nullable Thread loop;

	private volatile @Nullable ScheduledExecutorService ticker;

	@Autowired
	public VaultWatcher(NotesProperties properties, VaultFs fs, VaultReconciler reconciler, RescanScheduler rescans,
			EventHub hub) {
		this(fs, reconciler, rescans, hub, properties.watcher().enabled(), properties.watcher().debounce());
	}

	VaultWatcher(VaultFs fs, VaultReconciler reconciler, RescanScheduler rescans, EventHub hub, boolean enabled,
			Duration debounce) {
		this.fs = fs;
		this.reconciler = reconciler;
		this.rescans = rescans;
		this.hub = hub;
		this.enabled = enabled;
		this.debounceNanos = debounce.toNanos();
	}

	public WatcherMode mode() {
		return this.mode;
	}

	@Override
	public void start() {
		this.running = true;
		if (!this.enabled) {
			logger.info("The file watcher is disabled; external changes are found by the periodic rescan");
			this.mode = WatcherMode.DISABLED;
			return;
		}
		if (WINDOWS) {
			// JDK-6972833: Windows keeps a watched directory open, so renaming it fails with AccessDenied. Every
			// folder move and every folder delete (a move into .trash) would then answer permission-denied.
			logger.warn("WATCHER_DEGRADED the file watcher is not used on Windows, where it locks watched folders "
					+ "against renames (JDK-6972833); external changes are found by the periodic rescan");
			this.mode = WatcherMode.POLLING;
			this.rescans.request(false);
			return;
		}
		try {
			WatchService watchService = this.fs.root().getFileSystem().newWatchService();
			this.service = watchService;
			registerTree(this.fs.root());
			this.mode = WatcherMode.INOTIFY;
			Thread thread = Thread.ofPlatform().name("vault-watcher").daemon().start(() -> loop(watchService));
			this.loop = thread;
			ScheduledExecutorService executor = Executors
				.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("vault-watcher-tick").daemon().factory());
			executor.scheduleWithFixedDelay(this::safeTick, TICK_MILLIS, TICK_MILLIS, TimeUnit.MILLISECONDS);
			this.ticker = executor;
			logger.info("Watching {} folders for external changes", this.keys.size());
		}
		catch (IOException ex) {
			degrade(ex);
		}
		// Covers changes made between the startup index build and the watch registration.
		this.rescans.request(false);
	}

	@Override
	public void stop() {
		this.running = false;
		ScheduledExecutorService executor = this.ticker;
		this.ticker = null;
		if (executor != null) {
			executor.shutdownNow();
		}
		closeService();
		Thread thread = this.loop;
		this.loop = null;
		if (thread != null) {
			try {
				thread.join(TimeUnit.SECONDS.toMillis(5));
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
		}
		this.keys.clear();
		this.deadlines.clear();
	}

	@Override
	public boolean isRunning() {
		return this.running;
	}

	@Override
	public int getPhase() {
		return PHASE;
	}

	private void loop(WatchService watchService) {
		while (this.running) {
			WatchKey key;
			try {
				key = watchService.take();
			}
			catch (ClosedWatchServiceException ex) {
				return;
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				return;
			}
			Path dir = this.keys.get(key);
			if (dir == null) {
				key.cancel();
				this.rescans.request(true);
				continue;
			}
			for (WatchEvent<?> event : key.pollEvents()) {
				if (event.kind() == StandardWatchEventKinds.OVERFLOW) {
					logger.warn("The file watcher overflowed; rescanning the vault");
					this.rescans.request(true);
					continue;
				}
				handle(event.kind(), dir.resolve((Path) event.context()));
			}
			if (!key.reset()) {
				this.keys.remove(key);
			}
		}
	}

	private void handle(WatchEvent.Kind<?> kind, Path child) {
		String disk = relative(child);
		if (disk == null || isIgnored(disk)) {
			return;
		}
		if (kind == StandardWatchEventKinds.ENTRY_DELETE) {
			cancelUnder(child);
		}
		else if (kind == StandardWatchEventKinds.ENTRY_CREATE) {
			BasicFileAttributes attributes = VaultFs.attributes(child);
			if (attributes != null && attributes.isDirectory()) {
				try {
					registerTree(child);
				}
				catch (IOException ex) {
					degrade(ex);
				}
			}
		}
		this.deadlines.put(disk, System.nanoTime() + this.debounceNanos);
	}

	/** {@link #tick} for the scheduler: an exception escaping a scheduled task would cancel the ticker for good. */
	private void safeTick() {
		try {
			tick();
		}
		catch (RuntimeException | Error ex) {
			logger.error("The watcher's tick failed; it will run again", ex);
		}
	}

	/** Reconciles every path whose debounce deadline has passed; a busy vault retries on a later tick. */
	void tick() {
		long now = System.nanoTime();
		for (Map.Entry<String, Long> entry : this.deadlines.entrySet()) {
			if (now - entry.getValue() < 0) {
				continue;
			}
			String disk = entry.getKey();
			if (!this.deadlines.remove(disk, entry.getValue())) {
				continue;
			}
			try {
				this.reconciler.reconcile(new ApiPath(Normalizer.normalize(disk, Normalizer.Form.NFC), disk));
			}
			catch (NotesException ex) {
				this.deadlines.putIfAbsent(disk, now + this.debounceNanos);
			}
			catch (RuntimeException ex) {
				logger.warn("Could not reconcile {}: {}", disk, ex.toString());
			}
		}
	}

	/** Registers {@code root} and every folder under it, skipping hidden folders and links. */
	private void registerTree(Path root) throws IOException {
		WatchService watchService = this.service;
		if (watchService == null) {
			return;
		}
		Files.walkFileTree(root, new SimpleFileVisitor<>() {

			@Override
			public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attributes) throws IOException {
				if (!dir.equals(VaultWatcher.this.fs.root()) && dir.getFileName().toString().startsWith(".")) {
					return FileVisitResult.SKIP_SUBTREE;
				}
				WatchKey key = dir.register(watchService, StandardWatchEventKinds.ENTRY_CREATE,
						StandardWatchEventKinds.ENTRY_DELETE, StandardWatchEventKinds.ENTRY_MODIFY);
				VaultWatcher.this.keys.put(key, dir);
				return FileVisitResult.CONTINUE;
			}

			@Override
			public FileVisitResult visitFileFailed(Path file, IOException exc) {
				return FileVisitResult.CONTINUE;
			}

		});
	}

	/** A moved or deleted folder's watches would keep reporting under its old path. */
	private void cancelUnder(Path path) {
		this.keys.entrySet().removeIf((entry) -> {
			if (entry.getValue().startsWith(path)) {
				entry.getKey().cancel();
				return true;
			}
			return false;
		});
	}

	private void degrade(IOException ex) {
		logger.warn("WATCHER_DEGRADED the file watcher failed ({}); falling back to periodic rescans", ex.toString());
		closeService();
		this.keys.clear();
		if (this.mode != WatcherMode.POLLING) {
			this.mode = WatcherMode.POLLING;
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.WATCHER));
		}
	}

	private void closeService() {
		WatchService watchService = this.service;
		this.service = null;
		if (watchService != null) {
			try {
				watchService.close();
			}
			catch (IOException ex) {
				logger.debug("Closing the watch service failed: {}", ex.toString());
			}
		}
	}

	private @Nullable String relative(Path path) {
		Path root = this.fs.root();
		if (!path.startsWith(root) || path.equals(root)) {
			return null;
		}
		return root.relativize(path).toString().replace('\\', '/');
	}

	/** Hidden entries (and anything under them) and names the index ignores are never reconciled. */
	static boolean isIgnored(String disk) {
		for (String segment : disk.split("/")) {
			if (segment.startsWith(".")) {
				return true;
			}
		}
		return NameRules.isIgnored(disk.substring(disk.lastIndexOf('/') + 1));
	}

}
