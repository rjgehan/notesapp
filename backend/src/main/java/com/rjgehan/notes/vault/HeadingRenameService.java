package com.rjgehan.notes.vault;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FailedUpdate;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.HeadingRenameResult;
import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.LinkUpdate;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.bookmarks.BookmarkService;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.CommitFailedException;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.HeadingOcc;
import com.rjgehan.notes.index.LinkOcc;
import com.rjgehan.notes.index.LinkTextGenerator;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.MovePlan;
import com.rjgehan.notes.index.NoteParse;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.Syntax;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Updates {@code [[Note#Heading]]} links after a heading is renamed (ROADMAP item 21, DESIGN §5.22). The client renames
 * the heading in the note and saves it, then asks for this: every link in the vault that resolves to the note and
 * names the old heading in its subpath (any {@code #} segment, compared case-insensitively with whitespace collapsed,
 * as heading targets are) is rewritten to the new heading, splicing only the subpath, so the target, the display text,
 * the style and the embed mark stay as they were. Heading bookmarks of the note follow too. It runs under the vault
 * write lock, like a move, reads each note from disk, and commits the rewritten notes together. A document that links
 * to the heading (a {@code .tasks} list) is rewritten by its {@code DocumentIndexer}, as for a move (DESIGN §6.8).
 */
@Service
public class HeadingRenameService {

	private static final Logger logger = LoggerFactory.getLogger(HeadingRenameService.class);

	static final int MAX_HEADING = 1024;

	private final VaultPaths paths;

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final FileIndexer indexer;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final BookmarkService bookmarks;

	public HeadingRenameService(VaultPaths paths, VaultFs fs, VaultLocks locks, VaultIndex index, FileService files,
			FileIndexer indexer, VaultReconciler reconciler, CommitBatcher batcher, EventHub hub,
			BookmarkService bookmarks) {
		this.paths = paths;
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.indexer = indexer;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
		this.bookmarks = bookmarks;
	}

	/**
	 * One note's planned subpath splices, from the text the plan read; or, for a document, its whole new text as its
	 * indexer rewrote it ({@code document}, instead of {@code edits}).
	 */
	private record Planned(ApiPath note, String text, boolean hadBom, boolean lossy, List<MovePlan.Edit> edits,
			boolean notRewritable, DocumentIndexer.@Nullable Rewritten document) {

		int links() {
			return (this.document != null) ? this.document.links() : this.edits.size();
		}

	}

	/** {@code POST /api/notes/rename-heading}. */
	public HeadingRenameResult rename(@Nullable String apiPath, @Nullable String from, @Nullable String to,
			boolean dryRun, Identity identity, @Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		if (apiPath == null || apiPath.isBlank()) {
			errors.add(new FieldError("path", "is required"));
		}
		checkHeading(from, "from", errors);
		checkHeading(to, "to", errors);
		if (errors.isEmpty() && BookmarkService.headingKey(from).equals(BookmarkService.headingKey(to))) {
			errors.add(new FieldError("to", "must differ from the old heading (case and spaces do not count)"));
		}
		if (!errors.isEmpty()) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "Invalid heading rename", Map.of("errors", errors));
		}
		String oldHeading = from.strip();
		String newHeading = to.strip();
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.write()) {
			if (!dryRun) {
				this.reconciler.reconcileLocked(path);
			}
			// Indexed documents (.sheet, .canvas, .tasks, .excalidraw) have a NoteRecord too, but no editable headings.
			var file = this.index.file(path.nfc());
			NoteRecord note = this.index.note(path.nfc());
			if (file == null) {
				throw NotesException.notFound(path.nfc());
			}
			if (note == null || file.kind() != FileKind.NOTE) {
				throw NotesException.typeMismatch(path.nfc(), "note", "Only notes have headings: " + path.nfc());
			}
			checkHeadings(note, oldHeading, newHeading);
			Set<String> sources = new TreeSet<>(this.index.backlinkSources(path.nfc()));
			sources.add(path.nfc());
			List<Planned> plans = new ArrayList<>();
			for (String source : sources) {
				Planned planned = plan(source, path.nfc(), oldHeading, newHeading, dryRun);
				if (planned != null) {
					plans.add(planned);
				}
			}
			if (!dryRun) {
				// Pending edits are committed first, so the links commit holds only the rewrites (as for a move).
				flushPending();
			}
			List<LinkUpdate> updates = new ArrayList<>();
			List<FailedUpdate> failed = new ArrayList<>();
			List<FileEntry> entries = new ArrayList<>();
			List<ApiPath> written = new ArrayList<>();
			for (Planned planned : plans) {
				String source = planned.note().nfc();
				if (planned.lossy()) {
					failed.add(new FailedUpdate(source, FailedReason.NOT_UTF8));
					continue;
				}
				if (planned.notRewritable()) {
					failed.add(new FailedUpdate(source, FailedReason.NOT_REWRITABLE));
				}
				if (planned.links() == 0) {
					continue;
				}
				if (dryRun) {
					updates.add(new LinkUpdate(source, planned.links(), null));
					continue;
				}
				FileEntry entry = apply(planned, failed);
				if (entry != null) {
					updates.add(new LinkUpdate(entry.path(), planned.links(), entry.version()));
					entries.add(entry);
					written.add(planned.note());
				}
			}
			int bookmarked = this.bookmarks.headingRenamed(path.nfc(), oldHeading, newHeading, true, identity);
			if (dryRun) {
				return new HeadingRenameResult(true, path.nfc(), oldHeading, newHeading, updates, failed, bookmarked,
						null);
			}
			GitStore.Commit commit = null;
			if (!written.isEmpty()) {
				int count = written.size();
				String subject = "Update links after renaming heading “" + oldHeading + "” → “" + newHeading + "” in "
						+ path.nfc() + " (" + count + ((count == 1) ? " note)" : " notes)");
				String body = written.stream().map(ApiPath::nfc).collect(Collectors.joining("\n"));
				commit = this.batcher.commitNow(subject, body, Author.of(identity), written);
			}
			entries.forEach((entry) -> this.hub.publish(FileEvent.changed(entry, origin)));
			if (bookmarked > 0) {
				this.bookmarks.headingRenamed(path.nfc(), oldHeading, newHeading, false, identity);
			}
			logger.info("HEADING RENAME {} \"{}\" -> \"{}\" notes={} bookmarks={} client={} user={}", path.nfc(),
					oldHeading, newHeading, updates.size(), bookmarked, origin, identity.login());
			return new HeadingRenameResult(false, path.nfc(), oldHeading, newHeading, updates, failed, bookmarked,
					(commit != null) ? commit.id() : null);
		}
	}

	private static void checkHeading(@Nullable String heading, String field, List<FieldError> errors) {
		if (heading == null || heading.isBlank()) {
			errors.add(new FieldError(field, "is required"));
		}
		else if (heading.length() > MAX_HEADING || heading.contains("\n") || heading.contains("\r")) {
			errors.add(new FieldError(field, "must be one line of at most " + MAX_HEADING + " characters"));
		}
	}

	/**
	 * The note must have the new heading (it was saved first) and no longer the old one: while a heading still reads
	 * the old text, links to it are not broken, and rewriting them would point them elsewhere.
	 */
	private static void checkHeadings(NoteRecord note, String oldHeading, String newHeading) {
		String oldKey = BookmarkService.headingKey(oldHeading);
		String newKey = BookmarkService.headingKey(newHeading);
		boolean hasNew = false;
		for (HeadingOcc heading : note.parse().headings()) {
			String key = BookmarkService.headingKey(heading.text());
			if (key.equals(oldKey)) {
				throw new NotesException(ErrorCode.BAD_REQUEST,
						note.path() + " still has a heading “" + oldHeading + "”; its links are not changed",
						Map.of("errors", List.of(new FieldError("from", "is still a heading of the note"))));
			}
			hasNew |= key.equals(newKey);
		}
		if (!hasNew) {
			throw new NotesException(ErrorCode.BAD_REQUEST,
					note.path() + " has no heading “" + newHeading + "”; save the note first",
					Map.of("errors", List.of(new FieldError("to", "is not a heading of the note"))));
		}
	}

	/**
	 * The splices for one note, read from disk (from the index in a dry run, unless a {@code DocumentIndexer}
	 * supplements the note, whose indexed text is then more than the file). A note the watcher has not caught up with
	 * is reconciled first, so its external edit is indexed and committed as External, and never reverted. A file that
	 * is not a note (a document, DESIGN §6.8) is planned by {@link #planDocument}.
	 */
	private @Nullable Planned plan(String source, String target, String oldHeading, String newHeading, boolean dryRun)
			throws IOException {
		NoteRecord record = this.index.note(source);
		if (record == null) {
			return null;
		}
		String oldKey = BookmarkService.headingKey(oldHeading);
		if (this.indexer.kindOf(source) != FileKind.NOTE) {
			return planDocument(record, target, oldKey, newHeading, dryRun);
		}
		ApiPath note = existing(source);
		boolean supplemented = this.indexer.hasDocumentIndexer(source);
		String text;
		boolean hadBom;
		boolean lossy;
		if (dryRun && !supplemented) {
			text = record.text();
			hadBom = record.parse().hadBom();
			lossy = record.parse().lossy();
		}
		else {
			byte[] bytes = this.fs.readBytes(note.disk());
			if (!dryRun && !Hashing.blobId(bytes).equals(record.version())) {
				this.reconciler.reconcileLocked(note);
				NoteRecord current = this.index.note(source);
				record = (current != null) ? current : record;
			}
			TextCodec.Decoded decoded = TextCodec.decode(bytes);
			text = decoded.text();
			hadBom = decoded.hadBom();
			lossy = decoded.lossy();
		}
		Matched matched = match(text, MarkdownScanner.scan(text, hadBom, lossy).links(), source, target, oldKey,
				newHeading);
		if (matched.count() > 0 && lossy) {
			return new Planned(note, text, hadBom, true, List.of(), false, null);
		}
		boolean notRewritable = matched.notRewritable();
		if (supplemented) {
			// The links an indexer added after the note's text (an .excalidraw.md drawing's JSON) have no place in
			// the file, so the note is reported when one of them names the old heading.
			int end = text.length();
			List<LinkOcc> extra = record.parse().links().stream().filter((occ) -> occ.from() >= end).toList();
			notRewritable |= match(record.text(), extra, source, target, oldKey, newHeading).count() > 0;
		}
		if (matched.edits().isEmpty() && !notRewritable) {
			return null;
		}
		return new Planned(note, text, hadBom, false, matched.edits(), notRewritable, null);
	}

	/**
	 * A document's rewrite (a {@code .tasks} list, an {@code .excalidraw} drawing): its links point into the search
	 * text it was indexed from, which says whether any names the old heading; its {@code DocumentIndexer} then rewrites
	 * the file as a whole, as for a move (DESIGN §6.8), with a {@link DocumentIndexer.LinkRewriter} that changes heading
	 * subpaths only. One it cannot rewrite is reported as {@code not-rewritable}.
	 */
	private @Nullable Planned planDocument(NoteRecord record, String target, String oldKey, String newHeading,
			boolean dryRun) throws IOException {
		String source = record.path();
		if (match(record.text(), record.parse().links(), source, target, oldKey, newHeading).count() == 0) {
			return null;
		}
		ApiPath file = existing(source);
		byte[] bytes = this.fs.readBytes(file.disk());
		if (!dryRun && !Hashing.blobId(bytes).equals(record.version())) {
			this.reconciler.reconcileLocked(file);
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		if (decoded.lossy()) {
			return new Planned(file, decoded.text(), decoded.hadBom(), true, List.of(), false, null);
		}
		DocumentIndexer.Rewritten rewritten = this.indexer.rewriteDocument(source, source, decoded.text(),
				headingRewriter(source, target, oldKey, newHeading));
		if (rewritten == null) {
			return new Planned(file, decoded.text(), decoded.hadBom(), false, List.of(), true, null);
		}
		return (rewritten.links() > 0)
				? new Planned(file, decoded.text(), decoded.hadBom(), false, List.of(), false, rewritten) : null;
	}

	/** Rewrites the heading links of one Markdown fragment of a document; nothing it holds as a path changes. */
	private DocumentIndexer.LinkRewriter headingRewriter(String source, String target, String oldKey,
			String newHeading) {
		return new DocumentIndexer.LinkRewriter() {

			@Override
			public DocumentIndexer.@Nullable Rewritten markdown(String fragment) {
				Matched matched = match(fragment, MarkdownScanner.scanFragment(fragment).links(), source, target,
						oldKey, newHeading);
				if (matched.notRewritable()) {
					return null;
				}
				if (matched.edits().isEmpty()) {
					return new DocumentIndexer.Rewritten(fragment, 0);
				}
				String text = MoveService.splice(fragment, matched.edits());
				return (text != null) ? new DocumentIndexer.Rewritten(text, matched.edits().size()) : null;
			}

			@Override
			public String path(String path) {
				return path;
			}

		};
	}

	/** The links of a text that name the old heading: the splices, and whether one of them cannot be spliced. */
	private record Matched(List<MovePlan.Edit> edits, boolean notRewritable, int count) {
	}

	private Matched match(String text, List<LinkOcc> links, String source, String target, String oldKey,
			String newHeading) {
		List<MovePlan.Edit> edits = new ArrayList<>();
		boolean notRewritable = false;
		int count = 0;
		for (LinkOcc occ : links) {
			if (occ.subpath() == null) {
				continue;
			}
			String resolved = occ.target().isEmpty() ? source : this.index.resolveLink(occ.target(), source);
			if (!target.equals(resolved)) {
				continue;
			}
			int[] span = subpathSpan(text, occ);
			if (span == null) {
				continue;
			}
			boolean decode = occ.style() == LinkStyle.MARKDOWN && !occ.angle();
			String[] segments = text.substring(span[0], span[1]).split("#", -1);
			boolean matched = false;
			for (int i = 0; i < segments.length; i++) {
				String segment = decode ? Syntax.percentDecode(segments[i]) : segments[i];
				if (!segment.startsWith("^") && BookmarkService.headingKey(segment).equals(oldKey)) {
					segments[i] = newSegment(occ, newHeading);
					matched = true;
				}
			}
			if (!matched) {
				continue;
			}
			count++;
			String replacement = String.join("#", segments);
			boolean unsafe = replacement.contains("\u0000");
			String written = (!unsafe && occ.rewritable()) ? occ.quoting().encode(replacement) : null;
			if (written == null) {
				notRewritable = true;
				continue;
			}
			edits.add(new MovePlan.Edit(occ.from(), occ.to(), occ.raw(), span[0], span[1], written));
		}
		return new Matched(List.copyOf(edits), notRewritable, count);
	}

	/**
	 * The new heading as a subpath segment of this link: verbatim in a wikilink and an angle-bracket destination, and
	 * percent-encoded in a plain markdown destination. A heading the link's syntax cannot hold (a {@code |}, {@code #}
	 * or bracket in a wikilink, a {@code >} in angle brackets) gives NUL, which marks the link not rewritable.
	 */
	private static String newSegment(LinkOcc occ, String heading) {
		if (occ.style() == LinkStyle.WIKI) {
			return (heading.contains("|") || heading.contains("#") || heading.contains("[") || heading.contains("]"))
					? "\u0000" : heading;
		}
		if (occ.angle()) {
			return (heading.contains(">") || heading.contains("<") || heading.contains("#")) ? "\u0000" : heading;
		}
		return LinkTextGenerator.encodeMdPath(heading);
	}

	/**
	 * Where a link's subpath (after its first {@code #}) is in the text: up to the display separator or the closing
	 * brackets of a wikilink, and to the end of the destination of a markdown link. Null when it has none.
	 */
	static int @Nullable [] subpathSpan(String text, LinkOcc occ) {
		if (occ.style() == LinkStyle.WIKI) {
			int prefix = occ.embed() ? 3 : 2;
			String raw = occ.raw();
			if (raw.length() < prefix + 2) {
				return null;
			}
			String body = raw.substring(prefix, raw.length() - 2);
			int pipe = body.indexOf('|');
			int leftEnd = (pipe < 0) ? body.length() : (pipe > 0 && body.charAt(pipe - 1) == '\\') ? pipe - 1 : pipe;
			int hash = body.indexOf('#');
			if (hash < 0 || hash >= leftEnd) {
				return null;
			}
			int start = occ.from() + prefix;
			return new int[] { start + hash + 1, start + leftEnd };
		}
		int hash = occ.targetTo();
		if (hash >= text.length() || text.charAt(hash) != '#') {
			return null;
		}
		int end = hash + 1;
		while (end < occ.to()) {
			char c = text.charAt(end);
			if (occ.angle() ? c == '>' : (c == ')' || Character.isWhitespace(c))) {
				break;
			}
			end++;
		}
		return new int[] { hash + 1, end };
	}

	/** Writes one note's splices; a note whose links moved since the plan, or whose frontmatter would break, is skipped. */
	private @Nullable FileEntry apply(Planned planned, List<FailedUpdate> failed) {
		String source = planned.note().nfc();
		// A document was rewritten whole by its indexer, from the bytes read under this same write lock.
		String text = (planned.document() != null) ? planned.document().text()
				: MoveService.splice(planned.text(), planned.edits());
		if (text == null) {
			failed.add(new FailedUpdate(source, FailedReason.SPAN_MISMATCH));
			return null;
		}
		if (planned.document() == null && !MoveService.frontmatterSurvives(planned.text(), text)) {
			failed.add(new FailedUpdate(source, FailedReason.NOT_REWRITABLE));
			return null;
		}
		try {
			byte[] bytes = TextCodec.encode(text, planned.hadBom());
			this.fs.atomicWrite(planned.note().disk(), bytes);
			return this.files.indexWritten(planned.note(), bytes);
		}
		catch (IOException ex) {
			logger.warn("Could not update heading links in {}: {}", source, ex.toString());
			failed.add(new FailedUpdate(source, FailedReason.IO_ERROR));
			return null;
		}
	}

	private void flushPending() {
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			logger.warn("Pending changes could not be committed before a heading rename: {}", ex.getMessage());
		}
	}

	private ApiPath existing(String path) {
		String disk = this.index.diskPath(path);
		return new ApiPath(path, (disk != null) ? disk : path);
	}

}
