package com.rjgehan.notes.index;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.FolderEntry;
import com.rjgehan.notes.api.dto.GraphResponse;
import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.SkippedEntry;
import com.rjgehan.notes.settings.LinkFormat;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The in-memory vault index (DESIGN §5.5.1). One {@link ReentrantReadWriteLock} guards every structure; writers hold
 * it only to swap pre-built values in. Links are resolved inside the write lock at swap time, so a target created
 * concurrently is never missed.
 */
@Component
public class VaultIndex {

	private static final Comparator<String> FOLDER_ORDER = Comparator.comparing(PathNames::lower)
		.thenComparing(Comparator.naturalOrder());

	/** A consistent copy of the tree, sorted as {@code GET /api/tree} returns it. */
	public record Tree(List<FolderEntry> folders, List<FileEntry> files) {
	}

	/** Counts shown by {@code /api/status}. */
	public record Stats(int notes, int files, int folders, long bytes) {
	}

	/** What a folder removal took out of the index. */
	public record RemovedTree(List<String> files, List<String> folders) {
	}

	/**
	 * Told about files whose text is extracted for search outside the index (PDFs, DESIGN §5.5.10): called under the
	 * index write lock, so implementations only queue work.
	 */
	public interface ExtractionListener {

		/** A file was added or changed (size or mtime), or the whole index was rebuilt. */
		void extractable(FileRecord record);

		/** A file moved; its record (size and mtime) is unchanged. */
		void moved(FileRecord from, FileRecord to);

	}

	private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

	private final NavigableMap<String, FileRecord> files = new TreeMap<>();

	private final Map<String, List<String>> byLowerPath = new HashMap<>();

	private final Map<String, List<String>> byLowerName = new HashMap<>();

	private final TreeSet<String> folders = new TreeSet<>(FOLDER_ORDER);

	private final Map<String, String> lowerFolders = new HashMap<>();

	private final Map<String, NoteRecord> notes = new HashMap<>();

	/**
	 * Search documents of files whose text is extracted in the background (PDFs): only searched, never linked,
	 * tagged or counted as notes. The record's {@code version} is empty.
	 */
	private final Map<String, NoteRecord> extracted = new HashMap<>();

	private volatile @Nullable ExtractionListener extractionListener;

	private final Map<String, String> diskNames = new HashMap<>();

	private final LinkGraph links = new LinkGraph();

	private final TagIndex tags = new TagIndex();

	private final SearchIndex search = new SearchIndex();

	private final AtomicLong generation = new AtomicLong();

	/** Bumped when the link graph changes: a file appears, leaves or moves, or a note's links or tags change. */
	private final AtomicLong graphGeneration = new AtomicLong();

	/** Makes graph versions of different boots differ. */
	private final String instanceId = Long.toString(System.currentTimeMillis(), 36);

	private final AtomicInteger nextDocId = new AtomicInteger();

	private long totalBytes;

	private List<SkippedEntry> skipped = List.of();

	private final LinkResolver.Lookup lookup = new LinkResolver.Lookup() {

		@Override
		public List<String> filesByLowerPath(String lowerPath) {
			return VaultIndex.this.byLowerPath.getOrDefault(lowerPath, List.of());
		}

		@Override
		public List<String> filesByLowerName(String lowerName) {
			return VaultIndex.this.byLowerName.getOrDefault(lowerName, List.of());
		}

	};

	// ---------------------------------------------------------------- reads

	public @Nullable FileRecord file(String path) {
		return read(() -> this.files.get(path));
	}

	public @Nullable NoteRecord note(String path) {
		return read(() -> this.notes.get(path));
	}

	/**
	 * Every note, in no order: a snapshot for scans of the frontmatter (the calendar's dated notes, ROADMAP item 14)
	 * that run without the lock. Records are immutable.
	 */
	public List<NoteRecord> notes() {
		return read(() -> new ArrayList<>(this.notes.values()));
	}

	/** True for an indexed folder; the root {@code ""} always exists. */
	public boolean isFolder(String path) {
		return path.isEmpty() || read(() -> this.folders.contains(path));
	}

	/** The real path of the folder equal to {@code path} ignoring case (exact match preferred), or null. */
	public @Nullable String folderIgnoreCase(String path) {
		if (path.isEmpty()) {
			return "";
		}
		return read(() -> this.folders.contains(path) ? path : this.lowerFolders.get(PathNames.lower(path)));
	}

	/** The real path of a file equal to {@code path} ignoring case (exact match preferred), or null. */
	public @Nullable String fileIgnoreCase(String path) {
		return read(() -> {
			List<String> hits = this.byLowerPath.getOrDefault(PathNames.lower(path), List.of());
			if (hits.isEmpty()) {
				return null;
			}
			return hits.contains(path) ? path : hits.get(0);
		});
	}

	/** Every indexed file and folder whose path equals {@code path} ignoring case (exact matches included). */
	public List<String> caseVariants(String path) {
		String lower = PathNames.lower(path);
		return read(() -> {
			List<String> found = new ArrayList<>(this.byLowerPath.getOrDefault(lower, List.of()));
			for (String folder : this.folders) {
				if (PathNames.lower(folder).equals(lower)) {
					found.add(folder);
				}
			}
			return found;
		});
	}

	/** The repo-relative on-disk path of an indexed file or folder, or null when it is not indexed. */
	public @Nullable String diskPath(String path) {
		return read(() -> {
			if (path.isEmpty()) {
				return "";
			}
			if (!this.files.containsKey(path) && !this.folders.contains(path)) {
				return null;
			}
			return this.diskNames.getOrDefault(path, path);
		});
	}

	public Tree snapshotTree() {
		return read(() -> {
			List<FolderEntry> folderEntries = new ArrayList<>(this.folders.size());
			for (String folder : this.folders) {
				folderEntries.add(new FolderEntry(folder, PathNames.nameOf(folder)));
			}
			List<FileEntry> fileEntries = new ArrayList<>(this.files.size());
			for (FileRecord record : this.files.values()) {
				fileEntries.add(record.toEntry());
			}
			return new Tree(folderEntries, fileEntries);
		});
	}

	/** Every indexed file at any depth under {@code folder} ({@code ""} for the whole vault). */
	public List<FileRecord> filesUnder(String folder) {
		return read(() -> {
			if (folder.isEmpty()) {
				return List.copyOf(this.files.values());
			}
			return List.copyOf(this.files.subMap(folder + "/", true, folder + "0", false).values());
		});
	}

	/** An indexed file with its on-disk path and size. */
	public record SizedFile(String path, String disk, long size) {
	}

	/** Every indexed file larger than {@code bytes}, in path order (the large-file policy, DESIGN §5.8). */
	public List<SizedFile> filesLargerThan(long bytes) {
		return read(() -> {
			List<SizedFile> found = new ArrayList<>();
			for (FileRecord record : this.files.values()) {
				if (record.size() > bytes) {
					found.add(new SizedFile(record.path(), this.diskNames.getOrDefault(record.path(), record.path()),
							record.size()));
				}
			}
			return found;
		});
	}

	/** Every indexed file for which {@code filter} holds, in path order. */
	public List<FileRecord> files(Predicate<FileRecord> filter) {
		return read(() -> {
			List<FileRecord> found = new ArrayList<>();
			for (FileRecord record : this.files.values()) {
				if (filter.test(record)) {
					found.add(record);
				}
			}
			return found;
		});
	}

	/** Every indexed folder at any depth under {@code folder}, outermost first. */
	public List<String> foldersUnder(String folder) {
		return read(() -> {
			List<String> found = new ArrayList<>();
			for (String candidate : this.folders) {
				if (folder.isEmpty() || candidate.startsWith(folder + "/")) {
					found.add(candidate);
				}
			}
			found.sort(Comparator.comparingInt(PathNames::segmentCount).thenComparing(FOLDER_ORDER));
			return found;
		});
	}

	public @Nullable String resolveLink(String target, String sourcePath) {
		return read(() -> LinkResolver.resolve(target, sourcePath, this.lookup));
	}

	public String linkText(String targetPath, String sourcePath, LinkFormat format, LinkStyle style) {
		return read(() -> LinkTextGenerator.linkText(targetPath, sourcePath, format, style, this.lookup));
	}

	/**
	 * Plans the link rewrites for moving the files in {@code moved} ({@code old path → new path}), using the index as
	 * it is now and a simulated post-move lookup (DESIGN §5.6 step 2). For every link from a note outside the moved set
	 * that resolved to a moved file (inbound), the new text is the link text of the file's new path. Every other link
	 * whose resolution the move would change (links inside moved notes, and links elsewhere that a moved file would
	 * hijack) is rewritten to point at its original target. Links whose text would not change are left alone, and
	 * same-note links are never touched.
	 */
	public MovePlan planMove(Map<String, String> moved, LinkFormat format) {
		return read(() -> {
			LinkResolver.Lookup after = new MovedLookup(this.lookup, moved);
			Set<String> sources = new TreeSet<>();
			for (Map.Entry<String, String> entry : moved.entrySet()) {
				sources.addAll(this.links.sourcesLinkingTo(entry.getKey()));
				sources.addAll(this.links.sourcesInBucket(LinkResolver.fileNameKey(entry.getKey())));
				sources.addAll(this.links.sourcesInBucket(LinkResolver.fileNameKey(entry.getValue())));
				if (this.notes.containsKey(entry.getKey())) {
					sources.add(entry.getKey());
				}
			}
			List<MovePlan.NoteRewrite> rewrites = new ArrayList<>();
			for (String source : sources) {
				NoteRecord note = this.notes.get(source);
				if (note == null) {
					continue;
				}
				String newSource = moved.getOrDefault(source, source);
				List<MovePlan.Edit> edits = new ArrayList<>();
				boolean notRewritable = false;
				for (LinkGraph.Resolved resolved : this.links.outgoing(source)) {
					LinkOcc occ = resolved.occ();
					String before = resolved.target();
					if (before == null || occ.target().isEmpty()) {
						continue;
					}
					// Links between notes that move together (inside a moved folder) follow the outbound rule: they
					// are rewritten only when they would stop resolving to their target.
					boolean inbound = moved.containsKey(before) && !moved.containsKey(source);
					String desired = moved.getOrDefault(before, before);
					if (!inbound && desired.equals(LinkResolver.resolve(occ.target(), newSource, after))) {
						continue;
					}
					String plain = LinkTextGenerator.plainText(desired, newSource, format, occ.style(), after);
					String replacement = (occ.style() == LinkStyle.MARKDOWN && !occ.angle())
							? LinkTextGenerator.encodeMdPath(plain) : plain;
					String current = occ.rewritable() ? note.text().substring(occ.targetFrom(), occ.targetTo())
							: occ.target();
					if (replacement.equals(current)) {
						continue;
					}
					// In frontmatter, the new target is written for the YAML scalar's style ('' in single quotes, \"
					// in double quotes); a target that plain YAML would misread is not rewritten.
					String written = occ.rewritable() ? occ.quoting().encode(replacement) : null;
					if (written == null) {
						notRewritable = true;
						continue;
					}
					edits.add(new MovePlan.Edit(occ.from(), occ.to(), occ.raw(), occ.targetFrom(), occ.targetTo(),
							written));
				}
				if (!edits.isEmpty() || notRewritable) {
					rewrites.add(new MovePlan.NoteRewrite(source, newSource, note.version(), note.parse().lossy(),
							List.copyOf(edits), notRewritable));
				}
			}
			return new MovePlan(List.copyOf(rewrites));
		});
	}

	/**
	 * Rewrites the links of a document indexed through a {@link DocumentIndexer} ({@code source}, at its path before
	 * the move) by the rules of {@link #planMove}: a Markdown fragment's links are rewritten as a note's at the same
	 * path would be, and a vault path held as data follows the file it named. It reads the index as it is now, so it
	 * is used while planning, before the move.
	 */
	public DocumentIndexer.LinkRewriter documentRewriter(String source, Map<String, String> moved, LinkFormat format) {
		String newSource = moved.getOrDefault(source, source);
		return new DocumentIndexer.LinkRewriter() {

			@Override
			public DocumentIndexer.@Nullable Rewritten markdown(String fragment) {
				return read(() -> rewriteFragment(fragment, source, newSource, moved, format));
			}

			@Override
			public String path(String path) {
				return read(() -> {
					String before = LinkResolver.resolve("/" + path, source, VaultIndex.this.lookup);
					return (before != null && moved.containsKey(before)) ? moved.get(before) : path;
				});
			}

		};
	}

	private DocumentIndexer.@Nullable Rewritten rewriteFragment(String fragment, String source, String newSource,
			Map<String, String> moved, LinkFormat format) {
		LinkResolver.Lookup after = new MovedLookup(this.lookup, moved);
		List<MovePlan.Edit> edits = new ArrayList<>();
		for (LinkOcc occ : MarkdownScanner.scanFragment(fragment).links()) {
			String before = LinkResolver.resolve(occ.target(), source, this.lookup);
			if (before == null || occ.target().isEmpty()) {
				continue;
			}
			boolean inbound = moved.containsKey(before) && !moved.containsKey(source);
			String desired = moved.getOrDefault(before, before);
			if (!inbound && desired.equals(LinkResolver.resolve(occ.target(), newSource, after))) {
				continue;
			}
			String plain = LinkTextGenerator.plainText(desired, newSource, format, occ.style(), after);
			String replacement = (occ.style() == LinkStyle.MARKDOWN && !occ.angle())
					? LinkTextGenerator.encodeMdPath(plain) : plain;
			if (replacement.equals(fragment.substring(occ.targetFrom(), occ.targetTo()))) {
				continue;
			}
			String written = occ.rewritable() ? occ.quoting().encode(replacement) : null;
			if (written == null) {
				return null;
			}
			edits.add(new MovePlan.Edit(occ.from(), occ.to(), occ.raw(), occ.targetFrom(), occ.targetTo(), written));
		}
		edits.sort((a, b) -> Integer.compare(b.targetFrom(), a.targetFrom()));
		StringBuilder text = new StringBuilder(fragment);
		for (MovePlan.Edit edit : edits) {
			text.replace(edit.targetFrom(), edit.targetTo(), edit.replacement());
		}
		return new DocumentIndexer.Rewritten(text.toString(), edits.size());
	}

	/** The notes with at least one link resolving to {@code targetPath}. */
	public Set<String> backlinkSources(String targetPath) {
		return read(() -> this.links.sourcesLinkingTo(targetPath));
	}

	public List<LinkGraph.Resolved> outgoingLinks(String sourcePath) {
		return read(() -> this.links.outgoing(sourcePath));
	}

	/** A note and its links with their current resolution, read together. */
	public record NoteView(NoteRecord note, List<LinkGraph.Resolved> links) {
	}

	public @Nullable NoteView noteView(String path) {
		return read(() -> {
			NoteRecord note = this.notes.get(path);
			return (note != null) ? new NoteView(note, this.links.outgoing(path)) : null;
		});
	}

	/**
	 * Every note with its links as resolved now, in path order: a consistent snapshot for whole-vault scans (the
	 * compatibility report, ROADMAP item 24), which then run without the lock. Records are immutable.
	 */
	public List<NoteView> noteViews() {
		return read(() -> {
			List<NoteView> views = new ArrayList<>(this.notes.size());
			for (NoteRecord note : this.notes.values()) {
				views.add(new NoteView(note, this.links.outgoing(note.path())));
			}
			views.sort(Comparator.comparing((view) -> view.note().path()));
			return views;
		});
	}

	/** A note linking to some target, with its mtime and the links that resolve there. */
	public record Backlink(NoteRecord source, Instant mtime, List<LinkOcc> links) {
	}

	/** The notes with links or embeds resolving to {@code targetPath}, newest first. */
	public List<Backlink> backlinks(String targetPath) {
		return read(() -> {
			List<Backlink> found = new ArrayList<>();
			for (String source : this.links.sourcesLinkingTo(targetPath)) {
				NoteRecord note = this.notes.get(source);
				FileRecord record = this.files.get(source);
				if (note == null || record == null) {
					continue;
				}
				List<LinkOcc> occurrences = new ArrayList<>();
				for (LinkGraph.Resolved resolved : this.links.outgoing(source)) {
					if (targetPath.equals(resolved.target())) {
						occurrences.add(resolved.occ());
					}
				}
				found.add(new Backlink(note, record.mtime(), occurrences));
			}
			found.sort(Comparator.comparing(Backlink::mtime).reversed()
				.thenComparing((backlink) -> backlink.source().path()));
			return found;
		});
	}

	/** A note that may mention a name, with its mtime. */
	public record Candidate(NoteRecord note, Instant mtime) {
	}

	/**
	 * The notes whose body contains every token of at least one of {@code names}, newest first: the candidates for
	 * unlinked mentions, found through the search index so the scan stays sub-linear.
	 */
	public List<Candidate> mentionCandidates(List<String> names) {
		return read(() -> {
			BitSet docs = new BitSet();
			for (String name : names) {
				List<String> terms = Tokenizer.tokenize(name).stream().map(Tokenizer.Token::term).toList();
				if (!terms.isEmpty()) {
					docs.or(this.search.bodyCandidates(terms));
				}
			}
			List<Candidate> candidates = new ArrayList<>();
			docs.stream().forEach((docId) -> {
				String path = this.search.path(docId);
				NoteRecord note = (path != null) ? this.notes.get(path) : null;
				FileRecord record = (path != null) ? this.files.get(path) : null;
				if (note != null && record != null) {
					candidates.add(new Candidate(note, record.mtime()));
				}
			});
			candidates.sort(Comparator.comparing(Candidate::mtime).reversed()
				.thenComparing((candidate) -> candidate.note().path()));
			return candidates;
		});
	}

	/** One search result before snippets: the document (a note, or a file's extracted text), its kind and score. */
	public record SearchHit(NoteRecord note, FileKind kind, double score, Instant mtime) {
	}

	/**
	 * Every match of a query, sorted; the word and phrase patterns and the regular expressions to highlight; and the
	 * typo corrections that were applied.
	 */
	public record SearchOutcome(List<SearchHit> hits, List<TermPattern> patterns, List<Pattern> regexes,
			List<SearchEvaluation.Correction> corrections, SearchRegex.Budget budget) {
	}

	/** Search options (API.md §12.1). {@code budget} bounds regular expressions and scoped clauses. */
	public record SearchOptions(boolean prefix, boolean fuzzy, Predicate<String> excluded, boolean byMtime,
			Duration budget) {
	}

	/** {@link #search(SearchQuery, SearchOptions)} without typo tolerance and with a generous time budget. */
	public SearchOutcome search(SearchQuery query, boolean prefix, Predicate<String> excluded, boolean byMtime) {
		return search(query, new SearchOptions(prefix, false, excluded, byMtime, Duration.ofSeconds(30)));
	}

	/**
	 * Evaluates a query (API.md §12.1, {@link SearchEvaluation}): a group made only of negated clauses matches
	 * nothing. With {@code prefix}, a final bare word of two or more characters also matches as a prefix; with
	 * {@code fuzzy}, a word that is not in the index matches similar words. Documents for which {@code excluded} holds
	 * are never returned. Results are sorted by score (ties by mtime, newest first) or by mtime alone. Throws
	 * {@link SearchRegex.InvalidException} for an invalid regular expression and {@link SearchRegex.TimeoutException}
	 * when the evaluation runs out of time; the index lock is not held while regular expressions run.
	 */
	public SearchOutcome search(SearchQuery query, SearchOptions options) {
		SearchEvaluation evaluation = new SearchEvaluation(query, new SearchEvaluation.Options(options.prefix(),
				options.fuzzy(), options.excluded(), options.byMtime(), options.budget()));
		if (query.matchesNothing()) {
			return new SearchOutcome(List.of(), List.of(), List.of(), List.of(), evaluation.budget());
		}
		read(() -> {
			evaluation.resolve(this.searchSource);
			return null;
		});
		BitSet result = evaluation.evaluate();
		List<TermPattern> patterns = evaluation.positivePatterns();
		List<SearchHit> hits = read(() -> {
			List<SearchHit> found = new ArrayList<>();
			result.stream().forEach((docId) -> {
				String path = this.search.path(docId);
				NoteRecord note = (path != null) ? document(path) : null;
				FileRecord record = (path != null) ? this.files.get(path) : null;
				if (note != null && note.docId() == docId && record != null && !options.excluded().test(path)) {
					double score = patterns.isEmpty() ? 0 : this.search.score(docId, patterns);
					found.add(new SearchHit(note, record.kind(), score, record.mtime()));
				}
			});
			return found;
		});
		Comparator<SearchHit> newest = Comparator.comparing(SearchHit::mtime).reversed();
		Comparator<SearchHit> order = options.byMtime() ? newest
				: Comparator.comparingDouble(SearchHit::score).reversed().thenComparing(newest);
		hits.sort(order.thenComparing((hit) -> hit.note().path()));
		return new SearchOutcome(hits, patterns, evaluation.positiveRegexes(), evaluation.corrections(),
				evaluation.budget());
	}

	/** A note, or a file's extracted text. */
	private @Nullable NoteRecord document(String path) {
		NoteRecord note = this.notes.get(path);
		return (note != null) ? note : this.extracted.get(path);
	}

	/**
	 * Ranks the notes containing <em>any</em> of {@code terms} (normalized terms, as {@link Tokenizer} makes them) by
	 * BM25 summed over the terms they contain, best first (ties: newest first), at most {@code limit} of them. The
	 * retrieval behind Ask your vault (ROADMAP item 18): a question in natural language rarely has every word in one
	 * note, so the ordinary search, which ANDs its words, would find nothing. Notes for which {@code excluded} holds
	 * are never returned.
	 */
	public List<SearchHit> rankAny(List<String> terms, Predicate<String> excluded, int limit) {
		if (terms.isEmpty() || limit <= 0) {
			return List.of();
		}
		List<TermPattern> patterns = terms.stream().distinct().map((term) -> new TermPattern(List.of(term), false))
			.toList();
		return read(() -> {
			List<SearchHit> hits = new ArrayList<>();
			this.search.anyCandidates(terms).stream().forEach((docId) -> {
				String path = this.search.path(docId);
				NoteRecord note = (path != null) ? this.notes.get(path) : null;
				FileRecord record = (path != null) ? this.files.get(path) : null;
				if (note != null && note.docId() == docId && record != null && !excluded.test(path)) {
					hits.add(new SearchHit(note, record.kind(), this.search.score(docId, patterns), record.mtime()));
				}
			});
			hits.sort(Comparator.comparingDouble(SearchHit::score).reversed()
				.thenComparing(Comparator.comparing(SearchHit::mtime).reversed())
				.thenComparing((hit) -> hit.note().path()));
			return List.copyOf(hits.subList(0, Math.min(limit, hits.size())));
		});
	}

	/** The index as {@link SearchEvaluation} reads it; called under the read lock. */
	private final SearchEvaluation.Source searchSource = new SearchEvaluation.Source() {

		@Override
		public SearchIndex search() {
			return VaultIndex.this.search;
		}

		@Override
		public BitSet all() {
			return VaultIndex.this.search.all();
		}

		@Override
		public BitSet tagged(String tag) {
			BitSet matches = new BitSet();
			for (String path : VaultIndex.this.tags.notesWithTag(tag, true)) {
				NoteRecord note = VaultIndex.this.notes.get(path);
				if (note != null) {
					matches.set(note.docId());
				}
			}
			return matches;
		}

		@Override
		public BitSet pathContains(String needle, boolean nameOnly) {
			BitSet matches = new BitSet();
			for (Map<String, NoteRecord> documents : List.of(VaultIndex.this.notes, VaultIndex.this.extracted)) {
				for (NoteRecord note : documents.values()) {
					String haystack = PathNames.lower(nameOnly ? PathNames.nameOf(note.path()) : note.path());
					if (haystack.contains(needle)) {
						matches.set(note.docId());
					}
				}
			}
			return matches;
		}

		@Override
		public BitSet withProperty(PropertyClause clause) {
			BitSet matches = new BitSet();
			for (NoteRecord note : VaultIndex.this.notes.values()) {
				Frontmatter frontmatter = note.parse().frontmatter();
				if (frontmatter != null && clause.matches(frontmatter.data())) {
					matches.set(note.docId());
				}
			}
			return matches;
		}

		@Override
		public void retainPhrase(BitSet docs, TermPattern pattern) {
			keepPhraseMatches(docs, pattern);
		}

		@Override
		public SearchEvaluation.@Nullable DocRef[] snapshot() {
			SearchEvaluation.DocRef[] refs = new SearchEvaluation.DocRef[VaultIndex.this.nextDocId.get()];
			for (Map<String, NoteRecord> documents : List.of(VaultIndex.this.notes, VaultIndex.this.extracted)) {
				for (NoteRecord note : documents.values()) {
					if (note.docId() < refs.length) {
						refs[note.docId()] = new SearchEvaluation.DocRef(note.docId(), note,
								VaultIndex.this.search.body(note.docId()));
					}
				}
			}
			return refs;
		}

	};

	/**
	 * Clears the documents in which the phrase does not occur as consecutive tokens of one field. The search index
	 * answers from its kept token sequences; a note without them is tokenized again.
	 */
	private void keepPhraseMatches(BitSet docs, TermPattern pattern) {
		this.search.retainPhrase(docs, pattern, (docId) -> {
			String path = this.search.path(docId);
			NoteRecord note = (path != null) ? document(path) : null;
			if (note == null) {
				return false;
			}
			String basename = PathNames.basenameOf(PathNames.nameOf(note.path()));
			for (List<Tokenizer.Token> field : SearchIndex.fieldTokens(basename, note.text(), note.parse())) {
				if (pattern.occursIn(field)) {
					return true;
				}
			}
			return false;
		});
	}

	/**
	 * The link graph of {@code GET /api/graph} (API.md §11.4), without the files for which {@code excluded} holds.
	 * {@code exclusionKey} identifies that predicate, so a change of the excluded paths changes the version. When
	 * {@code since} equals the current version, nothing is built and the response says {@code unchanged}.
	 */
	public GraphResponse graph(Predicate<String> excluded, String exclusionKey, @Nullable String since) {
		return read(() -> {
			String version = this.instanceId + "-" + this.graphGeneration.get() + "-" + exclusionKey;
			if (version.equals(since)) {
				return new GraphResponse(version, true, List.of(), new int[0]);
			}
			return GraphBuilder.build(version, this.files.values(), this.links, this.tags, excluded);
		});
	}

	/** The parts of a file that the link graph shows: its links' targets and its tags. */
	private List<String> graphSignature(String path) {
		List<String> signature = new ArrayList<>();
		for (LinkGraph.Resolved link : this.links.outgoing(path)) {
			signature.add((link.target() != null) ? "=" + link.target() : "?" + link.occ().target());
		}
		signature.sort(null);
		for (String tag : this.tags.tagsOf(path)) {
			signature.add("#" + tag);
		}
		return signature;
	}

	public List<TagIndex.TagStat> tagStats() {
		return read(this.tags::stats);
	}

	public Set<String> notesWithTag(String tag, boolean nested) {
		return read(() -> this.tags.notesWithTag(tag, nested));
	}

	public Stats stats() {
		return read(() -> {
			// Documents (DocumentIndexer) are indexed like notes but are not counted as notes.
			int notes = 0;
			for (String path : this.notes.keySet()) {
				FileRecord record = this.files.get(path);
				if (record != null && record.kind() == FileKind.NOTE) {
					notes++;
				}
			}
			return new Stats(notes, this.files.size(), this.folders.size(), this.totalBytes);
		});
	}

	public List<SkippedEntry> skipped() {
		return read(() -> this.skipped);
	}

	/** Bumped on every mutation. */
	public long generation() {
		return this.generation.get();
	}

	// ---------------------------------------------------------------- extracted text (PDFs)

	/** Registers the one listener for files whose text is extracted in the background. */
	public void setExtractionListener(@Nullable ExtractionListener listener) {
		this.extractionListener = listener;
	}

	/** True for the kinds whose text is extracted in the background. */
	public static boolean isExtractable(FileRecord record) {
		return record.kind() == FileKind.PDF;
	}

	/**
	 * Swaps in the extracted text of a file, if it is still indexed with the size and mtime of {@code expected};
	 * returns false when it changed or went away meanwhile (the listener has then been told again). {@code doc} is
	 * the text tokenized by the caller, outside the lock.
	 */
	public boolean putExtracted(FileRecord expected, String text, NoteParse parse, SearchIndex.Doc doc) {
		return write(() -> {
			String path = expected.path();
			FileRecord current = this.files.get(path);
			if (current == null || !sameContent(current, expected)) {
				return false;
			}
			NoteRecord existing = this.extracted.get(path);
			int id = (existing != null) ? existing.docId() : this.nextDocId.getAndIncrement();
			this.extracted.put(path, new NoteRecord(path, "", text, parse, id));
			this.search.add(id, path, doc);
			return true;
		});
	}

	/** True when the file's extracted text is in the search index. */
	public boolean hasExtracted(String path) {
		return read(() -> this.extracted.containsKey(path));
	}

	private static boolean sameContent(FileRecord a, FileRecord b) {
		return a.kind() == b.kind() && a.size() == b.size() && a.mtime().equals(b.mtime());
	}

	// ---------------------------------------------------------------- writes

	/** Swaps a file in (adding any missing parent folders) and returns its tree entry. */
	public FileEntry put(IndexedFile file) {
		return write(() -> {
			putLocked(file);
			return file.record().toEntry();
		});
	}

	/**
	 * Adds a folder and any missing ancestors. {@code disk} is the folder's on-disk path. Returns the folders that
	 * were not indexed before, outermost first.
	 */
	public List<String> addFolder(String path, String disk) {
		return write(() -> addFolderLocked(path, disk));
	}

	public @Nullable FileRecord removeFile(String path) {
		return write(() -> {
			FileRecord removed = removeFileLocked(path);
			if (removed != null) {
				this.links.reresolveKeys(List.of(LinkResolver.fileNameKey(path)), this.lookup);
			}
			return removed;
		});
	}

	/** Removes a folder and everything under it. */
	public RemovedTree removeFolder(String path) {
		return write(() -> {
			List<String> removedFiles = new ArrayList<>();
			Set<String> keys = new LinkedHashSet<>();
			for (String filePath : List.copyOf(this.files.subMap(path + "/", true, path + "0", false).keySet())) {
				removeFileLocked(filePath);
				removedFiles.add(filePath);
				keys.add(LinkResolver.fileNameKey(filePath));
			}
			List<String> removedFolders = new ArrayList<>();
			for (String folder : List.copyOf(this.folders)) {
				if (folder.equals(path) || folder.startsWith(path + "/")) {
					removeFolderLocked(folder);
					removedFolders.add(folder);
				}
			}
			this.links.reresolveKeys(keys, this.lookup);
			return new RemovedTree(removedFiles, removedFolders);
		});
	}

	/**
	 * Re-keys a moved file, or a folder and everything under it, once it has moved on disk (DESIGN §5.6 step 5).
	 * Records keep their parse data; the moved notes' links are resolved from their new location, and every link in
	 * the moved files' name buckets is re-resolved. {@code toDisk} is the new on-disk path of {@code to}.
	 */
	public void move(String from, String to, String toDisk) {
		move(from, to, toDisk, null);
	}

	/**
	 * {@link #move(String, String, String)}, where a moved file whose new name is indexed differently (another kind,
	 * text limit or note-ness, after an extension change) takes {@code reindexed}, read from disk at its new path,
	 * instead of its re-keyed record.
	 */
	public void move(String from, String to, String toDisk, @Nullable IndexedFile reindexed) {
		write(() -> {
			Set<String> keys = new LinkedHashSet<>();
			if (this.files.containsKey(from) && reindexed != null) {
				removeFileLocked(from);
				addFolderLocked(PathNames.parentOf(to), PathNames.parentOf(toDisk));
				storeLocked(reindexed);
				NoteRecord note = this.notes.get(reindexed.path());
				if (note != null) {
					this.links.setNote(note.path(), note.parse().links(), this.lookup);
					this.tags.setNote(note.path(), note.parse().distinctTags());
				}
				keys.add(LinkResolver.fileNameKey(from));
				keys.add(LinkResolver.fileNameKey(reindexed.path()));
			}
			else if (this.files.containsKey(from)) {
				moveFileLocked(from, to, toDisk, keys);
			}
			else {
				String fromDisk = this.diskNames.getOrDefault(from, from);
				List<String> movedFolders = new ArrayList<>();
				for (String folder : this.folders) {
					if (PathNames.isAtOrUnder(folder, from)) {
						movedFolders.add(folder);
					}
				}
				movedFolders.sort(Comparator.comparingInt(PathNames::segmentCount));
				Map<String, String> folderDisks = new HashMap<>();
				movedFolders.forEach((folder) -> folderDisks.put(folder, this.diskNames.getOrDefault(folder, folder)));
				Map<String, String> fileDisks = new HashMap<>();
				for (String file : this.files.subMap(from + "/", true, from + "0", false).keySet()) {
					fileDisks.put(file, this.diskNames.getOrDefault(file, file));
				}
				movedFolders.forEach(this::removeFolderLocked);
				for (String folder : movedFolders) {
					addFolderLocked(rebase(folder, from, to), rebase(folderDisks.get(folder), fromDisk, toDisk));
				}
				fileDisks.forEach((file, disk) -> moveFileLocked(file, rebase(file, from, to),
						rebase(disk, fromDisk, toDisk), keys));
			}
			this.links.reresolveKeys(keys, this.lookup);
			return null;
		});
	}

	/** Replaces the whole index with a fresh build. */
	public void replaceAll(Collection<VaultWalk.FoundFolder> newFolders, Collection<IndexedFile> newFiles,
			List<SkippedEntry> newSkipped) {
		write(() -> {
			this.files.clear();
			this.byLowerPath.clear();
			this.byLowerName.clear();
			this.folders.clear();
			this.lowerFolders.clear();
			this.notes.clear();
			this.extracted.clear();
			this.diskNames.clear();
			this.links.clear();
			this.tags.clear();
			this.search.clear();
			this.totalBytes = 0;
			for (VaultWalk.FoundFolder folder : newFolders) {
				addFolderLocked(folder.path(), folder.disk());
			}
			for (IndexedFile file : newFiles) {
				storeLocked(file);
			}
			for (NoteRecord note : this.notes.values()) {
				this.links.setNote(note.path(), note.parse().links(), this.lookup);
				this.tags.setNote(note.path(), note.parse().distinctTags());
			}
			this.skipped = List.copyOf(newSkipped);
			this.graphGeneration.incrementAndGet();
			return null;
		});
	}

	public void setSkipped(List<SkippedEntry> newSkipped) {
		write(() -> {
			this.skipped = List.copyOf(newSkipped);
			return null;
		});
	}

	// ---------------------------------------------------------------- internals

	private void putLocked(IndexedFile file) {
		String path = file.path();
		boolean added = !this.files.containsKey(path);
		List<String> graphBefore = added ? List.of() : graphSignature(path);
		addFolderLocked(PathNames.parentOf(path), PathNames.parentOf(file.disk()));
		storeLocked(file);
		NoteRecord note = this.notes.get(path);
		if (note != null) {
			this.links.setNote(path, note.parse().links(), this.lookup);
			this.tags.setNote(path, note.parse().distinctTags());
		}
		else {
			this.links.removeNote(path);
			this.tags.removeNote(path);
		}
		if (!added && !graphBefore.equals(graphSignature(path))) {
			this.graphGeneration.incrementAndGet();
		}
		if (added) {
			this.links.reresolveKeys(List.of(LinkResolver.fileNameKey(path)), this.lookup);
		}
	}

	private void moveFileLocked(String from, String to, String toDisk, Set<String> keys) {
		FileRecord record = this.files.get(from);
		if (record == null) {
			return;
		}
		NoteRecord note = this.notes.get(from);
		NoteRecord text = this.extracted.get(from);
		removeFileLocked(from, false);
		addFolderLocked(PathNames.parentOf(to), PathNames.parentOf(toDisk));
		// The search document moves with its id; only its title terms change, and only on a rename.
		storeLocked(new IndexedFile(record.withPath(to), toDisk, (note != null) ? note.text() : null,
				(note != null) ? note.parse() : null, null), (note != null) ? note.docId() : -1, false);
		if (note != null) {
			this.search.move(note.docId(), to);
			this.links.setNote(to, note.parse().links(), this.lookup);
			this.tags.setNote(to, note.parse().distinctTags());
		}
		if (text != null) {
			this.extracted.put(to, new NoteRecord(to, text.version(), text.text(), text.parse(), text.docId()));
			this.search.move(text.docId(), to);
		}
		ExtractionListener listener = this.extractionListener;
		if (listener != null && isExtractable(record)) {
			listener.moved(record, record.withPath(to));
		}
		keys.add(LinkResolver.fileNameKey(from));
		keys.add(LinkResolver.fileNameKey(to));
	}

	/** {@code path} with its prefix {@code from} replaced by {@code to}. */
	private static String rebase(String path, String from, String to) {
		if (path.equals(from)) {
			return to;
		}
		if (path.startsWith(from + "/")) {
			return to + path.substring(from.length());
		}
		return PathNames.join(to, PathNames.nameOf(path));
	}

	private void storeLocked(IndexedFile file) {
		storeLocked(file, -1, true);
	}

	/**
	 * Stores records, lookup keys and the search document; link and tag indexing is the caller's job. A note keeps its
	 * document id across updates; {@code docId} (or -1) assigns a known one to a re-keyed note. A file whose text is
	 * extracted in the background drops its stale text when its content changed, and the listener is told
	 * ({@code notify} is false for a move, which keeps the text).
	 */
	private void storeLocked(IndexedFile file, int docId, boolean notify) {
		String path = file.path();
		FileRecord previous = this.files.put(path, file.record());
		if (notify && isExtractable(file.record())) {
			NoteRecord stale = this.extracted.get(path);
			if (stale != null && (previous == null || !sameContent(previous, file.record()))) {
				this.extracted.remove(path);
				this.search.remove(stale.docId());
				stale = null;
			}
			ExtractionListener listener = this.extractionListener;
			if (listener != null && stale == null) {
				listener.extractable(file.record());
			}
		}
		if (previous == null || previous.kind() != file.record().kind()) {
			this.graphGeneration.incrementAndGet();
		}
		if (previous != null) {
			this.totalBytes -= previous.size();
		}
		else {
			this.byLowerPath.computeIfAbsent(PathNames.lower(path), (k) -> new ArrayList<>(1)).add(path);
			this.byLowerName.computeIfAbsent(PathNames.lower(PathNames.nameOf(path)), (k) -> new ArrayList<>(1))
				.add(path);
		}
		this.totalBytes += file.record().size();
		if (file.disk().equals(path)) {
			this.diskNames.remove(path);
		}
		else {
			this.diskNames.put(path, file.disk());
		}
		NoteRecord existing = this.notes.get(path);
		if (file.text() != null && file.parse() != null) {
			int id = (existing != null) ? existing.docId() : (docId >= 0) ? docId : this.nextDocId.getAndIncrement();
			this.notes.put(path, new NoteRecord(path, file.record().version(), file.text(), file.parse(), id));
			if (file.search() != null) {
				this.search.add(id, path, file.search());
			}
		}
		else if (existing != null) {
			this.notes.remove(path);
			this.search.remove(existing.docId());
		}
		this.generation.incrementAndGet();
	}

	private @Nullable FileRecord removeFileLocked(String path) {
		return removeFileLocked(path, true);
	}

	/** {@code dropSearch} is false when the note is being re-keyed and keeps its search document. */
	private @Nullable FileRecord removeFileLocked(String path, boolean dropSearch) {
		FileRecord removed = this.files.remove(path);
		if (removed == null) {
			return null;
		}
		this.graphGeneration.incrementAndGet();
		this.totalBytes -= removed.size();
		removeFromList(this.byLowerPath, PathNames.lower(path), path);
		removeFromList(this.byLowerName, PathNames.lower(PathNames.nameOf(path)), path);
		this.diskNames.remove(path);
		NoteRecord note = this.notes.remove(path);
		if (note != null) {
			this.links.removeNote(path);
			this.tags.removeNote(path);
			if (dropSearch) {
				this.search.remove(note.docId());
			}
		}
		NoteRecord text = this.extracted.remove(path);
		if (text != null && dropSearch) {
			this.search.remove(text.docId());
		}
		this.generation.incrementAndGet();
		return removed;
	}

	private List<String> addFolderLocked(String path, String disk) {
		if (path.isEmpty() || this.folders.contains(path)) {
			return List.of();
		}
		List<String> added = new ArrayList<>();
		String[] segments = path.split("/");
		String[] diskSegments = disk.split("/");
		boolean diskAligned = segments.length == diskSegments.length;
		StringBuilder current = new StringBuilder();
		StringBuilder currentDisk = new StringBuilder();
		for (int i = 0; i < segments.length; i++) {
			if (i > 0) {
				current.append('/');
				currentDisk.append('/');
			}
			current.append(segments[i]);
			currentDisk.append(diskAligned ? diskSegments[i] : segments[i]);
			String folder = current.toString();
			if (this.folders.add(folder)) {
				this.lowerFolders.putIfAbsent(PathNames.lower(folder), folder);
				String folderDisk = currentDisk.toString();
				if (!folderDisk.equals(folder)) {
					this.diskNames.put(folder, folderDisk);
				}
				added.add(folder);
			}
		}
		if (!added.isEmpty()) {
			this.generation.incrementAndGet();
		}
		return added;
	}

	private void removeFolderLocked(String folder) {
		this.folders.remove(folder);
		this.diskNames.remove(folder);
		String lower = PathNames.lower(folder);
		if (folder.equals(this.lowerFolders.get(lower))) {
			this.lowerFolders.remove(lower);
			for (String other : this.folders) {
				if (PathNames.lower(other).equals(lower)) {
					this.lowerFolders.put(lower, other);
					break;
				}
			}
		}
		this.generation.incrementAndGet();
	}

	private static void removeFromList(Map<String, List<String>> map, String key, String value) {
		List<String> list = map.get(key);
		if (list != null) {
			list.remove(value);
			if (list.isEmpty()) {
				map.remove(key);
			}
		}
	}

	private <T extends @Nullable Object> T read(Supplier<T> action) {
		this.lock.readLock().lock();
		try {
			return action.get();
		}
		finally {
			this.lock.readLock().unlock();
		}
	}

	private <T extends @Nullable Object> T write(Supplier<T> action) {
		this.lock.writeLock().lock();
		try {
			return action.get();
		}
		finally {
			this.lock.writeLock().unlock();
		}
	}

}
