package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FailedUpdate;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.LinkUpdate;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.MovedFile;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.MovedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.CommitFailedException;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.IndexedFile;
import com.rjgehan.notes.index.LinkOcc;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.MovePlan;
import com.rjgehan.notes.index.NoteParse;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.LinkFormat;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Move and rename of files and folders with link rewriting (DESIGN §5.6). Everything runs under the vault write lock:
 * the plan is computed from the pre-move index, the entry moves on disk and is re-keyed in the index, a pure rename
 * is committed on its own (so per-note history follows the file), and only then are the rewritten notes written,
 * from their bytes on disk, and committed in a second commit.
 */
@Service
public class MoveService {

	private static final Logger logger = LoggerFactory.getLogger(MoveService.class);

	private final VaultPaths paths;

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final FileIndexer indexer;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final MoveLog moveLog;

	private final SettingsService settings;

	public MoveService(VaultPaths paths, VaultFs fs, VaultLocks locks, VaultIndex index, FileService files,
			FileIndexer indexer, VaultReconciler reconciler, CommitBatcher batcher, EventHub hub, MoveLog moveLog,
			SettingsService settings) {
		this.paths = paths;
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.indexer = indexer;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
		this.moveLog = moveLog;
		this.settings = settings;
	}

	/** {@code POST /api/move}. {@code updateLinks} defaults to {@code settings.files.autoUpdateLinks}. */
	public MoveResult move(String fromPath, String toPath, @Nullable Boolean updateLinks, boolean dryRun,
			Identity identity, @Nullable String origin) throws IOException {
		long started = System.nanoTime();
		ApiPath from = this.paths.resolve(fromPath, Mode.EXISTING);
		ApiPath to = this.paths.resolve(toPath, Mode.NEW);
		Settings current = this.settings.current();
		boolean rewrite = (updateLinks != null) ? updateLinks : current.files().autoUpdateLinks();
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.write()) {
			EntryType type = entryType(from);
			if (!dryRun) {
				reconcileMovedEntry(from, type);
				type = entryType(from);
			}
			checkTarget(from, to, type);
			Map<String, String> moved = movedFiles(from, to, type);
			MovePlan plan = rewrite ? plan(moved, current) : MovePlan.EMPTY;
			if (dryRun) {
				return dryRunResult(type, from, to, moved, plan);
			}
			flushPending();
			if (rewrite && reconcileStaleSources(plan)) {
				plan = plan(moved, current);
			}
			List<String> createdFolders = this.files.ensureParentFolders(to);
			try {
				moveOnDisk(from, to, type);
			}
			catch (IOException | RuntimeException ex) {
				this.files.publishFolders(createdFolders, origin);
				throw ex;
			}
			this.index.move(from.nfc(), to.nfc(), to.disk(), reindexed(from, to, type));
			moved.forEach(this.moveLog::record);
			Author author = Author.of(identity);
			boolean sameFolder = PathNames.lower(from.parent()).equals(PathNames.lower(to.parent()));
			String description = from.nfc() + " → " + to.nfc();
			GitStore.Commit renameCommit = this.batcher.commitNow((sameFolder ? "Rename " : "Move ") + description,
					null, author, List.of(from, to));

			Rewritten rewritten = applyRewrites(plan);
			GitStore.Commit linksCommit = null;
			if (!rewritten.paths().isEmpty()) {
				int count = rewritten.paths().size();
				String subject = "Update links after " + (sameFolder ? "renaming " : "moving ") + description + " ("
						+ count + ((count == 1) ? " note)" : " notes)");
				String body = rewritten.paths().stream().map(ApiPath::nfc).collect(Collectors.joining("\n"));
				linksCommit = this.batcher.commitNow(subject, body, author, rewritten.paths());
			}

			this.files.publishFolders(createdFolders, origin);
			this.hub.publish(new MovedEvent(from.nfc(), to.nfc(), type, origin));
			rewritten.entries().forEach((entry) -> this.hub.publish(FileEvent.changed(entry, origin)));
			GitStore.Commit last = (linksCommit != null) ? linksCommit : renameCommit;
			logger.info("MOVE {} links={} client={} user={} {}ms", description, rewritten.updates().size(), origin,
					identity.login(), (System.nanoTime() - started) / 1_000_000);
			return new MoveResult(false, type, from.nfc(), to.nfc(), movedFiles(moved), createdFolders,
					rewritten.updates(), rewritten.failed(), (last != null) ? last.id() : null);
		}
	}

	private EntryType entryType(ApiPath from) {
		for (int attempt = 0; attempt < 2; attempt++) {
			if (this.index.file(from.nfc()) != null) {
				return EntryType.FILE;
			}
			if (this.index.isFolder(from.nfc())) {
				return EntryType.FOLDER;
			}
			if (attempt == 0) {
				this.reconciler.reconcileLocked(from);
			}
		}
		throw NotesException.notFound(from.nfc());
	}

	/**
	 * {@code to} must not exist, except as a case-only rename of {@code from} itself; no sibling may differ from it
	 * only by case; a folder cannot move into itself; no parent of {@code to} may be a file.
	 */
	private void checkTarget(ApiPath from, ApiPath to, EntryType type) {
		String source = from.nfc();
		String target = to.nfc();
		if (type == EntryType.FOLDER && (target.equals(source)
				|| PathNames.lower(target).startsWith(PathNames.lower(source) + "/"))) {
			throw NotesException.moveIntoSelf(source, target);
		}
		for (String parent = to.parent(); !parent.isEmpty(); parent = PathNames.parentOf(parent)) {
			String file = this.index.fileIgnoreCase(parent);
			if (file != null) {
				throw NotesException.typeMismatch(target, "folder", "A parent of " + target + " is a file: " + file);
			}
		}
		for (String existing : this.index.caseVariants(target)) {
			if (existing.equals(source) && !target.equals(source)) {
				continue;
			}
			throw existing.equals(target) ? NotesException.alreadyExists(target, existing)
					: NotesException.caseCollision(target, existing);
		}
		if (!isCaseOnly(from, to) && this.fs.attributes(to.disk()) != null) {
			// On disk but not yet indexed: an external create the watcher has not reported.
			this.reconciler.reconcileLocked(to);
			throw NotesException.alreadyExists(target, target);
		}
	}

	/** {@code old path → new path} for the file, or for every file under the folder. */
	private Map<String, String> movedFiles(ApiPath from, ApiPath to, EntryType type) {
		Map<String, String> moved = new LinkedHashMap<>();
		if (type == EntryType.FILE) {
			moved.put(from.nfc(), to.nfc());
			return moved;
		}
		for (FileRecord record : this.index.filesUnder(from.nfc())) {
			moved.put(record.path(), to.nfc() + record.path().substring(from.nfc().length()));
		}
		return moved;
	}

	/**
	 * Brings the moved file, or every entry under the moved folder, in line with the disk. An external edit the watcher
	 * has not reconciled yet is indexed, announced and queued as External now, so {@link #flushPending} commits it and
	 * the rename commit, which stages the new path from disk, stays a pure rename. A folder is compared like a rescan:
	 * size and mtime first, hashing only the text files that differ.
	 */
	private void reconcileMovedEntry(ApiPath from, EntryType type) {
		if (type == EntryType.FILE) {
			this.reconciler.reconcileLocked(from);
		}
		else {
			this.reconciler.reconcileTreeLocked(from);
		}
	}

	/**
	 * The rewrite plan; a file that will no longer be a note after the move never has its own content rewritten. A
	 * document indexed through a {@code DocumentIndexer} (a {@code .tasks} list) has only non-rewritable links, whose
	 * offsets point into its search text: its indexer rewrites it as a whole instead ({@link #documentRewrite}), and
	 * one it cannot rewrite stays in the plan without edits and is reported as {@code not-rewritable}.
	 */
	private MovePlan plan(Map<String, String> moved, Settings current) {
		LinkFormat format = current.files().newLinkFormat();
		MovePlan plan = this.index.planMove(moved, format);
		List<MovePlan.NoteRewrite> notes = new ArrayList<>();
		for (MovePlan.NoteRewrite rewrite : plan.rewrites()) {
			if (this.indexer.kindOf(rewrite.target()) != FileKind.NOTE
					&& this.indexer.kindOf(rewrite.source()) == FileKind.NOTE) {
				continue;
			}
			MovePlan.NoteRewrite document = rewrite.notRewritable() ? documentRewrite(rewrite, moved, format) : null;
			if (document == null) {
				notes.add(rewrite);
			}
			else if (document.document() != null && document.document().links() > 0) {
				notes.add(document);
			}
		}
		return new MovePlan(List.copyOf(notes));
	}

	/**
	 * A document's rewrite as its new text, made by its indexer from the bytes the plan was computed from; null when
	 * the file is not such a document, changed since it was indexed, or cannot be rewritten.
	 */
	private MovePlan.@Nullable NoteRewrite documentRewrite(MovePlan.NoteRewrite rewrite, Map<String, String> moved,
			LinkFormat format) {
		if (rewrite.lossy() || this.index.note(rewrite.source()) == null) {
			return null;
		}
		byte[] bytes;
		try {
			bytes = this.fs.readBytes(existing(rewrite.source()).disk());
		}
		catch (IOException ex) {
			return null;
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		if (decoded.lossy() || !Hashing.blobId(bytes).equals(rewrite.version())) {
			return null;
		}
		DocumentIndexer.Rewritten text = this.indexer.rewriteDocument(rewrite.source(), rewrite.target(),
				decoded.text(), this.index.documentRewriter(rewrite.source(), moved, format));
		if (text == null) {
			return null;
		}
		return new MovePlan.NoteRewrite(rewrite.source(), rewrite.target(), rewrite.version(), false, List.of(), false,
				text);
	}

	/**
	 * A renamed file whose new name is indexed differently (an extension change: {@code .txt} to {@code .md} makes it a
	 * note, the reverse makes it plain text) is read again from disk; any other moved file keeps its record. When it
	 * cannot be read, it is re-keyed and the reconciler, which checks the kind, repairs it later.
	 */
	private @Nullable IndexedFile reindexed(ApiPath from, ApiPath to, EntryType type) {
		if (type != EntryType.FILE || this.indexer.indexesAlike(from.nfc(), to.nfc())) {
			return null;
		}
		try {
			return this.indexer.load(to.nfc(), to.disk());
		}
		catch (IOException ex) {
			logger.warn("Could not index {} after renaming it: {}", to.nfc(), ex.toString());
			return null;
		}
	}

	/** Pending edits are committed before the move, so the rename commit stays a pure rename. */
	private void flushPending() {
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			logger.warn("Pending changes could not be committed before a move: {}", ex.getMessage());
		}
	}

	/**
	 * A note edited outside the app and not reconciled yet would have its edit reverted by a rewrite planned from the
	 * index. Such notes are reconciled now (indexed, announced, queued for an External commit) so the plan can be
	 * recomputed from their real content. Returns true when any was stale.
	 */
	private boolean reconcileStaleSources(MovePlan plan) throws IOException {
		boolean stale = false;
		for (MovePlan.NoteRewrite rewrite : plan.rewrites()) {
			ApiPath source = existing(rewrite.source());
			byte[] bytes;
			try {
				bytes = this.fs.readBytes(source.disk());
			}
			catch (IOException ex) {
				bytes = null;
			}
			if (bytes == null || !Hashing.blobId(bytes).equals(rewrite.version())) {
				this.reconciler.reconcileLocked(source);
				stale = true;
			}
		}
		return stale;
	}

	private void moveOnDisk(ApiPath from, ApiPath to, EntryType type) throws IOException {
		try {
			if (isCaseOnly(from, to)) {
				moveCaseOnly(from, to, type);
			}
			else {
				moveEntry(from.disk(), to.disk(), type);
			}
		}
		catch (FileAlreadyExistsException ex) {
			this.reconciler.reconcileLocked(to);
			throw NotesException.alreadyExists(to.nfc(), to.nfc());
		}
	}

	/**
	 * A case-only rename takes two renames on case-insensitive filesystems, through a hidden sibling name in the same
	 * folder: a crash between them leaves the entry beside its old name (not in {@code .notesapp/tmp}, which is
	 * emptied at startup), and a failed second rename moves it back before the error is reported.
	 */
	private void moveCaseOnly(ApiPath from, ApiPath to, EntryType type) throws IOException {
		String stage = VaultFs.siblingTempName(from.disk());
		moveEntry(from.disk(), stage, type);
		try {
			moveEntry(stage, to.disk(), type);
		}
		catch (IOException | RuntimeException ex) {
			try {
				moveEntry(stage, from.disk(), type);
			}
			catch (IOException | RuntimeException rollback) {
				ex.addSuppressed(rollback);
				logger.error("A case-only rename of {} failed half-way; the entry is at {}", from.disk(), stage);
			}
			throw ex;
		}
	}

	private void moveEntry(String fromDisk, String toDisk, EntryType type) throws IOException {
		if (type == EntryType.FILE) {
			this.fs.moveExclusive(fromDisk, toDisk);
		}
		else {
			this.fs.moveDirectory(fromDisk, toDisk);
		}
	}

	private static boolean isCaseOnly(ApiPath from, ApiPath to) {
		return !from.disk().equals(to.disk()) && PathNames.lower(from.disk()).equals(PathNames.lower(to.disk()));
	}

	private record Rewritten(List<LinkUpdate> updates, List<FailedUpdate> failed, List<FileEntry> entries,
			List<ApiPath> paths) {
	}

	/**
	 * Writes each planned note from its bytes on disk, splicing edits from the end backwards. A note whose bytes are not
	 * valid UTF-8 is never rewritten; one whose link spans no longer match the plan is skipped.
	 */
	private Rewritten applyRewrites(MovePlan plan) {
		List<LinkUpdate> updates = new ArrayList<>();
		List<FailedUpdate> failed = new ArrayList<>();
		List<FileEntry> entries = new ArrayList<>();
		List<ApiPath> written = new ArrayList<>();
		for (MovePlan.NoteRewrite rewrite : plan.rewrites()) {
			if (rewrite.lossy()) {
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_UTF8));
				continue;
			}
			if (rewrite.notRewritable()) {
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_REWRITABLE));
			}
			if (rewrite.document() != null) {
				applyDocument(rewrite, rewrite.document(), updates, failed, entries, written);
				continue;
			}
			if (rewrite.edits().isEmpty()) {
				continue;
			}
			ApiPath note = existing(rewrite.target());
			try {
				byte[] bytes = this.fs.readBytes(note.disk());
				TextCodec.Decoded decoded = TextCodec.decode(bytes);
				if (decoded.lossy()) {
					failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_UTF8));
					continue;
				}
				String text = splice(decoded.text(), rewrite.edits());
				if (text == null) {
					logger.warn("Links in {} changed since the move was planned; not rewritten", note.nfc());
					failed.add(new FailedUpdate(rewrite.target(), FailedReason.SPAN_MISMATCH));
					continue;
				}
				if (!frontmatterSurvives(decoded.text(), text)) {
					logger.warn("Rewriting the links in {} would change its frontmatter; not rewritten", note.nfc());
					failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_REWRITABLE));
					continue;
				}
				byte[] updated = TextCodec.encode(text, decoded.hadBom());
				this.fs.atomicWrite(note.disk(), updated);
				FileEntry entry = this.files.indexWritten(note, updated);
				updates.add(new LinkUpdate(entry.path(), rewrite.edits().size(), entry.version()));
				entries.add(entry);
				written.add(note);
			}
			catch (IOException ex) {
				logger.warn("Could not update links in {}: {}", note.nfc(), ex.toString());
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.IO_ERROR));
			}
		}
		return new Rewritten(updates, failed, entries, written);
	}

	/** Writes a document its indexer rewrote, unless it changed since the plan was made. */
	private void applyDocument(MovePlan.NoteRewrite rewrite, DocumentIndexer.Rewritten document,
			List<LinkUpdate> updates, List<FailedUpdate> failed, List<FileEntry> entries, List<ApiPath> written) {
		ApiPath file = existing(rewrite.target());
		try {
			byte[] bytes = this.fs.readBytes(file.disk());
			if (!Hashing.blobId(bytes).equals(rewrite.version())) {
				logger.warn("{} changed since the move was planned; links not rewritten", file.nfc());
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.SPAN_MISMATCH));
				return;
			}
			byte[] updated = TextCodec.encode(document.text(), TextCodec.decode(bytes).hadBom());
			this.fs.atomicWrite(file.disk(), updated);
			FileEntry entry = this.files.indexWritten(file, updated);
			updates.add(new LinkUpdate(entry.path(), document.links(), entry.version()));
			entries.add(entry);
			written.add(file);
		}
		catch (IOException ex) {
			logger.warn("Could not update links in {}: {}", file.nfc(), ex.toString());
			failed.add(new FailedUpdate(rewrite.target(), FailedReason.IO_ERROR));
		}
	}

	/**
	 * The safety net behind the quoting rules of {@link LinkOcc.Quoting}: a rewrite may not break a note's
	 * frontmatter, nor make it gain or lose links (a stray {@code " #"} turns the rest of a plain value into a
	 * comment). True when {@code before} has no frontmatter, so body-only rewrites cost one scan.
	 */
	static boolean frontmatterSurvives(String before, String after) {
		NoteParse old = MarkdownScanner.scan(before, false, false);
		if (old.frontmatter() == null) {
			return true;
		}
		NoteParse updated = MarkdownScanner.scan(after, false, false);
		return updated.frontmatter() != null
				&& (old.frontmatterError() != null || updated.frontmatterError() == null)
				&& frontmatterLinks(old) == frontmatterLinks(updated);
	}

	private static long frontmatterLinks(NoteParse parse) {
		return parse.links().stream().filter(LinkOcc::inFrontmatter).count();
	}

	/** Applies the edits from the end of the text backwards; null when a link no longer reads as planned. */
	static @Nullable String splice(String text, List<MovePlan.Edit> edits) {
		List<MovePlan.Edit> ordered = new ArrayList<>(edits);
		ordered.sort((a, b) -> Integer.compare(b.from(), a.from()));
		StringBuilder out = new StringBuilder(text);
		for (MovePlan.Edit edit : ordered) {
			if (edit.to() > text.length() || !text.substring(edit.from(), edit.to()).equals(edit.raw())) {
				return null;
			}
			out.replace(edit.targetFrom(), edit.targetTo(), edit.replacement());
		}
		return out.toString();
	}

	private MoveResult dryRunResult(EntryType type, ApiPath from, ApiPath to, Map<String, String> moved,
			MovePlan plan) {
		List<LinkUpdate> updates = new ArrayList<>();
		List<FailedUpdate> failed = new ArrayList<>();
		for (MovePlan.NoteRewrite rewrite : plan.rewrites()) {
			if (rewrite.lossy()) {
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_UTF8));
				continue;
			}
			if (rewrite.notRewritable()) {
				failed.add(new FailedUpdate(rewrite.target(), FailedReason.NOT_REWRITABLE));
			}
			if (rewrite.document() != null) {
				updates.add(new LinkUpdate(rewrite.target(), rewrite.document().links(), null));
			}
			else if (!rewrite.edits().isEmpty()) {
				updates.add(new LinkUpdate(rewrite.target(), rewrite.edits().size(), null));
			}
		}
		return new MoveResult(true, type, from.nfc(), to.nfc(), movedFiles(moved), List.of(), updates, failed, null);
	}

	private static List<MovedFile> movedFiles(Map<String, String> moved) {
		return moved.entrySet().stream().map((e) -> new MovedFile(e.getKey(), e.getValue())).toList();
	}

	private ApiPath existing(String path) {
		String disk = this.index.diskPath(path);
		return new ApiPath(path, (disk != null) ? disk : path);
	}

}
