package com.rjgehan.notes.support;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.function.Predicate;

import com.rjgehan.notes.bookmarks.BookmarkService;
import com.rjgehan.notes.canvas.CanvasDocumentIndexer;
import com.rjgehan.notes.config.JsonConfig;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.drawings.ExcalidrawDocumentIndexer;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.history.HistoryService;
import com.rjgehan.notes.history.LargeFiles;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.IndexBuilder;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.publish.PublishService;
import com.rjgehan.notes.publish.SnapshotStore;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.sheets.SheetDocumentIndexer;
import com.rjgehan.notes.tasks.TaskDocumentIndexer;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.AttachmentService;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.FolderService;
import com.rjgehan.notes.vault.HeadingRenameService;
import com.rjgehan.notes.vault.MoveLog;
import com.rjgehan.notes.vault.MoveService;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.TrashService;
import com.rjgehan.notes.vault.TrashStore;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.vault.VaultLocks;
import com.rjgehan.notes.vault.VaultPaths;
import com.rjgehan.notes.watch.VaultReconciler;
import org.eclipse.jgit.api.errors.GitAPIException;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.json.JsonMapper;

/**
 * The real backend object graph over a temp vault, without Spring: a controllable clock, a recording event hub and a
 * git store whose commits can be made to fail.
 */
public final class TestVault implements AutoCloseable {

	/** A JSON mapper configured like the application's. */
	public static final JsonMapper JSON = JsonMapper.builder().addModule(JsonConfig.notesModule()).build();

	public static final Identity ALICE = new Identity("alice@github", "Alice", null, Identity.Source.TAILSCALE);

	public static final Identity BOB = new Identity("bob@github", "Bob", null, Identity.Source.TAILSCALE);

	public final Path root;

	public final MutableClock clock = new MutableClock(Instant.parse("2026-10-16T12:00:00Z"));

	public final NotesProperties properties;

	public final VaultFs fs;

	public final VaultIndex index = new VaultIndex();

	public final VaultLocks locks = new VaultLocks(Duration.ofSeconds(5));

	public final FileKinds kinds;

	public final VaultPaths paths;

	public final FileIndexer indexer;

	public final RecordingEventHub hub;

	public final FailingGitStore git;

	public final CommitBatcher batcher;

	public final VaultReconciler reconciler;

	public final MoveLog moveLog = new MoveLog();

	public final FileService files;

	public final FolderService folders;

	public final HistoryService history;

	public final IndexBuilder builder;

	public final NameRules nameRules;

	public final SettingsService settings;

	public final BookmarkService bookmarks;

	public final SnapshotStore snapshots;

	public final PublishService publish;

	public final TrashStore trashStore;

	public final LargeFiles largeFiles;

	public final TrashService trash;

	public final MoveService moves;

	public final AttachmentService attachments;

	public final HeadingRenameService headings;

	private TestVault(Path root, Map<String, String> overrides, Function<NotesProperties, VaultFs> fsFactory) {
		this.root = root;
		Map<String, String> settings = new HashMap<>();
		settings.put("notes.git.commit-quiet-period", "30s");
		settings.put("notes.git.commit-max-delay", "5m");
		settings.putAll(overrides);
		this.properties = TestProperties.forVault(root, settings);
		this.fs = fsFactory.apply(this.properties);
		this.kinds = new FileKinds(this.properties);
		this.paths = new VaultPaths(this.index, this.fs);
		this.indexer = new FileIndexer(this.fs, this.kinds, List.of(new ExcalidrawDocumentIndexer(JSON),
				new SheetDocumentIndexer(JSON), new TaskDocumentIndexer(JSON, this.clock),
				new CanvasDocumentIndexer(JSON)));
		this.hub = new RecordingEventHub(this.properties, this.clock);
		this.largeFiles = new LargeFiles(this.index, this.properties);
		this.git = new FailingGitStore(this.fs, this.properties, this.clock, this.largeFiles);
		this.trashStore = new TrashStore(this.fs, JSON, this.clock);
		this.batcher = new CommitBatcher(this.git, this.index, this.fs, this.hub, this.clock, this.properties);
		this.reconciler = new VaultReconciler(this.locks, this.fs, this.index, this.indexer, this.batcher, this.hub,
				this.clock);
		this.files = new FileService(this.paths, this.fs, this.locks, this.index, this.kinds, this.indexer,
				this.reconciler, this.batcher, this.hub, this.moveLog, this.trashStore, this.largeFiles,
				this.properties);
		this.folders = new FolderService(this.paths, this.locks, this.index, this.files, this.hub);
		this.history = new HistoryService(this.git, this.batcher, this.paths, this.index, this.locks, this.fs,
				this.kinds, this.files, this.moveLog, this.hub, this.largeFiles);
		this.builder = new IndexBuilder(this.fs, this.indexer, this.index);
		this.nameRules = new NameRules(this.kinds);
		this.settings = new SettingsService(this.fs, this.batcher, this.hub, this.clock, JSON);
		this.bookmarks = new BookmarkService(this.fs, this.index, this.batcher, this.hub, this.clock, JSON);
		this.trash = new TrashService(this.paths, this.fs, this.locks, this.index, this.files, this.trashStore,
				this.reconciler, this.batcher, this.hub, this.bookmarks);
		this.snapshots = new SnapshotStore(this.properties);
		this.publish = new PublishService(this.properties, this.fs, this.index, this.files, this.batcher,
				this.snapshots, this.clock, JSON);
		this.moves = new MoveService(this.paths, this.fs, this.locks, this.index, this.files, this.indexer,
				this.reconciler, this.batcher, this.hub, this.moveLog, this.settings, this.bookmarks, this.publish);
		this.attachments = new AttachmentService(this.paths, this.nameRules, this.files, this.index, this.settings);
		this.headings = new HeadingRenameService(this.paths, this.fs, this.locks, this.index, this.files,
				this.indexer, this.reconciler, this.batcher, this.hub, this.bookmarks);
	}

	/** Prepares the vault, opens git and builds the index, like the startup sequence. */
	public static TestVault start(Path root) throws IOException {
		return start(root, Map.of());
	}

	/** The object graph without the startup steps, for tests of the startup sequence itself. */
	public static TestVault create(Path root, Map<String, String> overrides) {
		return new TestVault(root, overrides, VaultFs::new);
	}

	/** A clock at the same fixed start instant as every test vault's. */
	public static MutableClock newClock() {
		return new MutableClock(Instant.parse("2026-10-16T12:00:00Z"));
	}

	public static TestVault start(Path root, Map<String, String> overrides) throws IOException {
		return start(root, overrides, VaultFs::new);
	}

	/** Like {@link #start(Path, Map)}, with an instrumented {@link VaultFs}. */
	public static TestVault start(Path root, Map<String, String> overrides,
			Function<NotesProperties, VaultFs> fsFactory) throws IOException {
		TestVault vault = new TestVault(root, overrides, fsFactory);
		vault.fs.prepareTmp();
		vault.git.openOrInit();
		vault.builder.build();
		vault.git.syncLargeFiles();
		return vault;
	}

	public ApiPath path(String path) {
		return this.paths.resolve(path, VaultPaths.Mode.EXISTING);
	}

	/** Commits the pending batch now. */
	public GitStore.Commit flush() {
		return this.batcher.flush();
	}

	@Override
	public void close() {
		this.git.close();
	}

	/** A clock tests can move forward. */
	public static final class MutableClock extends Clock {

		private volatile Instant now;

		MutableClock(Instant start) {
			this.now = start;
		}

		public void advance(Duration duration) {
			this.now = this.now.plus(duration);
		}

		@Override
		public ZoneId getZone() {
			return ZoneOffset.UTC;
		}

		@Override
		public Clock withZone(ZoneId zone) {
			return this;
		}

		@Override
		public Instant instant() {
			return this.now;
		}

	}

	/** Records every published event. */
	public static final class RecordingEventHub extends EventHub {

		public final List<VaultEvent> published = new CopyOnWriteArrayList<>();

		/** Events for which {@link #publish} throws, as a broken event stream once could. */
		public volatile Predicate<VaultEvent> failing = (event) -> false;

		RecordingEventHub(NotesProperties properties, Clock clock) {
			super(properties, clock);
		}

		@Override
		public void publish(VaultEvent event) {
			if (this.failing.test(event)) {
				throw new IllegalStateException("simulated: publishing " + event.eventName() + " failed");
			}
			this.published.add(event);
			super.publish(event);
		}

		public List<String> names() {
			return this.published.stream().map(VaultEvent::eventName).toList();
		}

	}

	/**
	 * A git store whose commits fail while {@link #failing} is set, which runs {@link #beforeCommit} before staging
	 * (so a test can pause a commit in progress), and which records the largest blob {@link #readAt} buffered.
	 */
	public static final class FailingGitStore extends GitStore {

		public volatile boolean failing;

		public volatile Runnable beforeCommit = () -> {
		};

		public final AtomicLong largestBlobRead = new AtomicLong();

		FailingGitStore(VaultFs fs, NotesProperties properties, Clock clock, LargeFiles largeFiles) {
			super(fs, properties, clock, largeFiles);
		}

		@Override
		public Commit commit(Collection<ApiPath> present, Collection<ApiPath> removed,
				Function<List<Change>, Message> message, Author author) throws IOException, GitAPIException {
			this.beforeCommit.run();
			if (this.failing) {
				throw new IOException("simulated: disk full");
			}
			return super.commit(present, removed, message, author);
		}

		@Override
		public @Nullable Blob readAt(String commitId, String path) throws IOException {
			Blob blob = super.readAt(commitId, path);
			if (blob != null) {
				this.largestBlobRead.accumulateAndGet(blob.bytes().length, Math::max);
			}
			return blob;
		}

	}

}
