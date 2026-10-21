package com.rjgehan.notes.index;

import java.time.Duration;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntPredicate;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import java.util.stream.IntStream;

import com.rjgehan.notes.index.SearchQuery.And;
import com.rjgehan.notes.index.SearchQuery.Kind;
import com.rjgehan.notes.index.SearchQuery.Leaf;
import com.rjgehan.notes.index.SearchQuery.Node;
import com.rjgehan.notes.index.SearchQuery.Not;
import com.rjgehan.notes.index.SearchQuery.Or;
import com.rjgehan.notes.index.SearchQuery.Scope;
import com.rjgehan.notes.index.SearchQuery.Scoped;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Evaluates one query (API.md §12.1, DESIGN §5.5.10) in three steps, so the index lock is never held while regular
 * expressions run:
 * <ol>
 * <li>{@link #resolve} (under the index read lock): word and phrase clauses become term patterns, with prefix
 * expansion and typo variants, and are answered from the postings; tag, path and file filters from the index. When
 * the query has regular expressions or {@code line:}/{@code section:} scopes, the documents are snapshotted
 * (immutable records and the arrays the index keeps).</li>
 * <li>{@link #evaluate} (no lock): the boolean tree is evaluated from the cheapest clauses to the most expensive,
 * each expensive one only over the documents still in play, in parallel, under the query's time budget.</li>
 * <li>{@link VaultIndex} then scores and sorts the matching documents (under the read lock again).</li>
 * </ol>
 * A group (or the whole query) made only of negated clauses matches nothing; negations only remove what the other
 * clauses of the same group match. A word or phrase without letters or digits is ignored.
 */
final class SearchEvaluation {

	/** At most this many typo variants are tried for one term. */
	static final int MAX_VARIANTS = 8;

	/** Below this many documents an expensive clause is evaluated on the calling thread. */
	private static final int PARALLEL_THRESHOLD = 64;

	/** Search options. {@code budget} bounds regular expressions and scoped clauses together. */
	record Options(boolean prefix, boolean fuzzy, Predicate<String> excluded, boolean byMtime, Duration budget) {

		static Options of(boolean prefix, Predicate<String> excluded, boolean byMtime) {
			return new Options(prefix, false, excluded, byMtime, Duration.ofSeconds(30));
		}

	}

	/** A word that matched nothing as typed, and the vocabulary terms used in its place. */
	record Correction(String term, List<String> replacements) {
	}

	/** One document as the evaluation sees it outside the lock. {@code body} is null when the index kept none. */
	record DocRef(int docId, NoteRecord note, SearchIndex.@Nullable Body body) {
	}

	/** What {@link #resolve} needs from the index; every method is called under its read lock. */
	interface Source {

		SearchIndex search();

		/** Every searchable document. */
		BitSet all();

		/** Documents tagged {@code tag} or a nested {@code tag/…}. */
		BitSet tagged(String tag);

		/** Documents whose lower-cased path (or file name) contains {@code needle}. */
		BitSet pathContains(String needle, boolean nameOnly);

		/** Keeps the documents in which the phrase occurs as consecutive tokens of one field. */
		void retainPhrase(BitSet docs, TermPattern pattern);

		/** Every searchable document, indexed by id. */
		@Nullable DocRef[] snapshot();

	}

	private static final class LeafState {

		final Leaf leaf;

		final boolean negated;

		final boolean scoped;

		boolean neutral;

		@Nullable TermPattern pattern;

		@Nullable Map<String, Long> positions;

		/** Matching documents, for clauses the index answers; null for regular expressions. */
		@Nullable BitSet docs;

		@Nullable Pattern regex;

		LeafState(Leaf leaf, boolean negated, boolean scoped) {
			this.leaf = leaf;
			this.negated = negated;
			this.scoped = scoped;
		}

	}

	private final SearchQuery query;

	private final Options options;

	private final Map<Leaf, LeafState> leaves = new IdentityHashMap<>();

	private final Map<Node, Boolean> neutral = new IdentityHashMap<>();

	private final Map<Node, Boolean> expensive = new IdentityHashMap<>();

	private final Map<String, List<String>> corrections = new LinkedHashMap<>();

	private final SearchRegex.Budget budget;

	private BitSet all = new BitSet();

	private @Nullable DocRef @Nullable [] docs;

	/** Compiles the query's regular expressions; throws {@link SearchRegex.InvalidException} for a bad one. */
	SearchEvaluation(SearchQuery query, Options options) {
		this.query = query;
		this.options = options;
		this.budget = new SearchRegex.Budget(options.budget());
		if (query.root() != null) {
			collect(query.root(), false, false);
		}
	}

	private void collect(Node node, boolean negated, boolean scoped) {
		switch (node) {
			case Leaf leaf -> {
				LeafState state = new LeafState(leaf, negated, scoped);
				if (leaf.regex()) {
					state.regex = SearchRegex.compile(leaf.value());
				}
				this.leaves.put(leaf, state);
			}
			case And and -> and.children().forEach((child) -> collect(child, negated, scoped));
			case Or or -> or.children().forEach((child) -> collect(child, negated, scoped));
			case Not not -> collect(not.child(), !negated, scoped);
			case Scoped inner -> collect(inner.child(), negated, true);
		}
	}

	// ---------------------------------------------------------------- step 1: resolve (under the read lock)

	void resolve(Source source) {
		SearchIndex search = source.search();
		this.all = source.all();
		for (LeafState state : this.leaves.values()) {
			Leaf leaf = state.leaf;
			if (leaf.isText()) {
				resolveText(state, source, search);
			}
			else if (leaf.kind() == Kind.TAG && !leaf.regex()) {
				String tag = leaf.value().startsWith("#") ? leaf.value().substring(1) : leaf.value();
				state.docs = source.tagged(tag);
			}
			else if ((leaf.kind() == Kind.PATH || leaf.kind() == Kind.FILE) && !leaf.regex()) {
				state.docs = source.pathContains(PathNames.lower(leaf.value()), leaf.kind() == Kind.FILE);
			}
		}
		if (this.query.root() != null && isExpensive(this.query.root())) {
			this.docs = source.snapshot();
		}
	}

	private void resolveText(LeafState state, Source source, SearchIndex search) {
		Leaf leaf = state.leaf;
		List<String> terms = Tokenizer.tokenize(leaf.value()).stream().map(Tokenizer.Token::term).toList();
		if (terms.isEmpty()) {
			state.neutral = true;
			return;
		}
		boolean prefix = this.options.prefix() && leaf.last() && leaf.kind() == Kind.WORD && !state.negated
				&& terms.get(terms.size() - 1).length() >= 2;
		TermPattern pattern = new TermPattern(terms, prefix);
		if (this.options.fuzzy() && !state.negated) {
			List<Set<String>> variants = new ArrayList<>(terms.size());
			boolean any = false;
			for (int i = 0; i < terms.size(); i++) {
				String term = terms.get(i);
				boolean known = pattern.isPrefix(i) ? search.hasPrefix(term) : search.hasTerm(term);
				int edits = known ? 0 : Fuzzy.allowedEdits(term);
				List<String> similar = (edits > 0) ? search.similarTerms(term, edits, MAX_VARIANTS) : List.of();
				if (!similar.isEmpty()) {
					this.corrections.putIfAbsent(term, similar);
					any = true;
				}
				variants.add(Set.copyOf(similar));
			}
			if (any) {
				pattern = pattern.withVariants(variants);
			}
		}
		state.pattern = pattern;
		BitSet matches = search.candidates(pattern);
		if (pattern.isPhrase()) {
			source.retainPhrase(matches, pattern);
		}
		state.docs = matches;
		if (state.scoped) {
			state.positions = search.positions(pattern);
		}
	}

	// ---------------------------------------------------------------- step 2: evaluate (no lock)

	/** The matching documents. Throws {@link SearchRegex.TimeoutException} when the budget runs out. */
	BitSet evaluate() {
		Node root = this.query.root();
		if (root == null || isNeutral(root)) {
			return new BitSet();
		}
		return eval(root, this.all);
	}

	/** The documents of {@code restrict} that match {@code node}; {@code restrict} is never changed. */
	private BitSet eval(Node node, BitSet restrict) {
		if (restrict.isEmpty()) {
			return new BitSet();
		}
		return switch (node) {
			case Leaf leaf -> evalLeaf(state(leaf), restrict);
			case And and -> evalAnd(and, restrict);
			case Or or -> {
				BitSet result = new BitSet();
				for (Node child : or.children()) {
					if (isNeutral(child)) {
						continue;
					}
					BitSet remaining = (BitSet) restrict.clone();
					remaining.andNot(result);
					result.or(eval(child, remaining));
				}
				yield result;
			}
			// A negation on its own (not inside a group with positive clauses) matches nothing.
			case Not not -> new BitSet();
			case Scoped scoped -> evalScoped(scoped, restrict);
		};
	}

	private BitSet evalAnd(And and, BitSet restrict) {
		List<Node> positives = new ArrayList<>();
		List<Node> negatives = new ArrayList<>();
		for (Node child : and.children()) {
			if (isNeutral(child)) {
				continue;
			}
			if (child instanceof Not not) {
				negatives.add(not.child());
			}
			else {
				positives.add(child);
			}
		}
		if (positives.isEmpty()) {
			return new BitSet();
		}
		positives.sort(Comparator.comparingInt((Node child) -> isExpensive(child) ? 1 : 0));
		negatives.sort(Comparator.comparingInt((Node child) -> isExpensive(child) ? 1 : 0));
		BitSet result = (BitSet) restrict.clone();
		for (Node child : positives) {
			result = eval(child, result);
			if (result.isEmpty()) {
				return result;
			}
		}
		for (Node child : negatives) {
			result.andNot(eval(child, result));
		}
		return result;
	}

	private BitSet evalLeaf(LeafState state, BitSet restrict) {
		if (state.docs != null) {
			BitSet result = (BitSet) state.docs.clone();
			result.and(restrict);
			return result;
		}
		return filter(restrict, (ref) -> matchesDocument(state, ref));
	}

	private BitSet evalScoped(Scoped scoped, BitSet restrict) {
		BitSet candidates = necessary(scoped.child());
		candidates.and(restrict);
		return filter(candidates, (ref) -> anyUnit(scoped, ref));
	}

	/** The documents of {@code docs} for which {@code test} holds, evaluated in parallel for many documents. */
	private BitSet filter(BitSet docs, Predicate<DocRef> test) {
		@Nullable DocRef[] refs = this.docs;
		if (refs == null) {
			throw new IllegalStateException("documents were not snapshotted");
		}
		IntPredicate matches = (docId) -> {
			this.budget.check();
			DocRef ref = (docId < refs.length) ? refs[docId] : null;
			if (ref == null) {
				return false;
			}
			try {
				return test.test(ref);
			}
			catch (StackOverflowError ex) {
				// Java's regex engine recurses for some patterns; too deep a recursion is as bad as too long.
				throw new SearchRegex.TimeoutException(ex);
			}
		};
		IntStream ids = docs.stream();
		if (docs.cardinality() >= PARALLEL_THRESHOLD) {
			ids = ids.parallel();
		}
		BitSet result = new BitSet();
		for (int docId : ids.filter(matches).toArray()) {
			result.set(docId);
		}
		return result;
	}

	/**
	 * A superset of the documents that can match {@code node} within one unit, from the clauses the index answers,
	 * so scoped clauses are checked only where they can match.
	 */
	private BitSet necessary(Node node) {
		return switch (node) {
			case Leaf leaf -> {
				LeafState state = state(leaf);
				yield (state.docs != null) ? (BitSet) state.docs.clone() : (BitSet) this.all.clone();
			}
			case And and -> {
				BitSet result = null;
				for (Node child : and.children()) {
					if (child instanceof Not || isNeutral(child)) {
						continue;
					}
					BitSet part = necessary(child);
					if (result == null) {
						result = part;
					}
					else {
						result.and(part);
					}
				}
				yield (result != null) ? result : new BitSet();
			}
			case Or or -> {
				BitSet result = new BitSet();
				for (Node child : or.children()) {
					if (!isNeutral(child)) {
						result.or(necessary(child));
					}
				}
				yield result;
			}
			case Not not -> (BitSet) this.all.clone();
			case Scoped scoped -> necessary(scoped.child());
		};
	}

	// ---------------------------------------------------------------- documents and units

	/** A document-level clause that the index could not answer: a regular expression. */
	private boolean matchesDocument(LeafState state, DocRef ref) {
		Pattern regex = state.regex;
		if (regex == null) {
			return false;
		}
		NoteRecord note = ref.note();
		return switch (state.leaf.kind()) {
			case REGEX -> find(regex, note.text());
			case PATH -> find(regex, note.path());
			case FILE -> find(regex, PathNames.nameOf(note.path()));
			case TAG -> {
				for (String tag : note.parse().distinctTags()) {
					if (find(regex, tag)) {
						yield true;
					}
				}
				yield false;
			}
			case WORD, PHRASE -> false;
		};
	}

	private boolean find(Pattern regex, String text) {
		return SearchRegex.find(regex, SearchRegex.text(text, this.budget), 0, text.length());
	}

	/** A line or section of a document: body tokens {@code [tokenFrom, tokenTo)}, characters {@code [from, to)}. */
	private record Unit(int tokenFrom, int tokenTo, int from, int to) {
	}

	/** Per-document state while its units are checked: the budgeted text and the term masks of each pattern. */
	private final class DocContext {

		final DocRef ref;

		final CharSequence text;

		final Map<LeafState, long[]> masks = new IdentityHashMap<>();

		DocContext(DocRef ref) {
			this.ref = ref;
			this.text = SearchRegex.text(ref.note().text(), SearchEvaluation.this.budget);
		}

		boolean occurs(LeafState state, Unit unit) {
			TermPattern pattern = state.pattern;
			if (pattern == null) {
				return false;
			}
			SearchIndex.Body body = this.ref.body();
			int size = pattern.terms().size();
			if (body == null || state.positions == null || size > SearchIndex.maxSequencePattern()) {
				// No token sequence was kept for this document: tokenize the unit.
				return pattern.occursIn(Tokenizer.tokenize(this.ref.note().text(), unit.from(), unit.to()));
			}
			long[] termMasks = this.masks.computeIfAbsent(state, (s) -> {
				Map<String, Long> positions = s.positions;
				long[] result = new long[body.terms().length];
				for (int j = 0; j < result.length; j++) {
					Long mask = (positions != null) ? positions.get(body.terms()[j]) : null;
					result[j] = (mask != null) ? mask : 0L;
				}
				return result;
			});
			return SearchIndex.occurs(body.sequence(), termMasks, size, unit.tokenFrom(), unit.tokenTo());
		}

	}

	/** True when some line or section of the document matches the scoped clause. */
	private boolean anyUnit(Scoped scoped, DocRef ref) {
		DocContext context = new DocContext(ref);
		NoteParse parse = ref.note().parse();
		String text = ref.note().text();
		int[] lineStarts = parse.lineStarts();
		int lines = lineStarts.length;
		int[] lineTokens = (ref.body() != null) ? ref.body().lineTokens() : null;
		Frontmatter frontmatter = parse.frontmatter();
		int first = (frontmatter != null) ? Math.min(lines, frontmatter.closingLine() + 1) : 0;
		if (scoped.scope() == Scope.LINE) {
			for (int line = first; line < lines; line++) {
				Unit unit = new Unit(token(lineTokens, line), token(lineTokens, line + 1), lineStarts[line],
						MarkdownScanner.contentEnd(text, lineStarts, line));
				if (matchesUnit(scoped.child(), context, unit)) {
					return true;
				}
			}
			return false;
		}
		boolean[] breaks = new boolean[lines + 1];
		for (HeadingOcc heading : parse.headings()) {
			if (heading.line() < lines) {
				breaks[heading.line()] = true;
			}
		}
		for (int line = first; line < lines; line++) {
			if (lineStarts[line] < text.length() && text.charAt(lineStarts[line]) == '\f') {
				breaks[line] = true;
			}
		}
		int start = first;
		for (int line = first + 1; line <= lines; line++) {
			if (line == lines || breaks[line]) {
				int end = (line < lines) ? lineStarts[line] : text.length();
				Unit unit = new Unit(token(lineTokens, start), token(lineTokens, line), lineStarts[start], end);
				if (matchesUnit(scoped.child(), context, unit)) {
					return true;
				}
				start = line;
			}
		}
		return false;
	}

	private static int token(int @Nullable [] lineTokens, int line) {
		return (lineTokens != null) ? lineTokens[Math.min(line, lineTokens.length - 1)] : 0;
	}

	private boolean matchesUnit(Node node, DocContext context, Unit unit) {
		return switch (node) {
			case Leaf leaf -> {
				LeafState state = state(leaf);
				if (leaf.isText()) {
					yield context.occurs(state, unit);
				}
				if (leaf.kind() == Kind.REGEX) {
					yield state.regex != null && SearchRegex.find(state.regex, context.text, unit.from(), unit.to());
				}
				// Filters keep their document-level meaning.
				yield (state.docs != null) ? state.docs.get(context.ref.docId())
						: matchesDocument(state, context.ref);
			}
			case And and -> {
				boolean positive = false;
				for (Node child : and.children()) {
					if (isNeutral(child) || child instanceof Not) {
						continue;
					}
					positive = true;
					if (!matchesUnit(child, context, unit)) {
						yield false;
					}
				}
				if (!positive) {
					yield false;
				}
				for (Node child : and.children()) {
					if (child instanceof Not not && !isNeutral(not) && matchesUnit(not.child(), context, unit)) {
						yield false;
					}
				}
				yield true;
			}
			case Or or -> {
				for (Node child : or.children()) {
					if (!isNeutral(child) && matchesUnit(child, context, unit)) {
						yield true;
					}
				}
				yield false;
			}
			case Not not -> false;
			// A scope inside a scope is answered for the whole document.
			case Scoped scoped -> anyUnit(scoped, context.ref);
		};
	}

	// ---------------------------------------------------------------- tree properties

	private LeafState state(Leaf leaf) {
		LeafState state = this.leaves.get(leaf);
		if (state == null) {
			throw new IllegalStateException("unknown clause " + leaf);
		}
		return state;
	}

	/** True for a clause without letters or digits, or a group of such clauses: it is ignored. */
	private boolean isNeutral(Node node) {
		Boolean known = this.neutral.get(node);
		if (known != null) {
			return known;
		}
		boolean result = switch (node) {
			case Leaf leaf -> state(leaf).neutral;
			case And and -> and.children().stream().allMatch(this::isNeutral);
			case Or or -> or.children().stream().allMatch(this::isNeutral);
			case Not not -> isNeutral(not.child());
			case Scoped scoped -> isNeutral(scoped.child());
		};
		this.neutral.put(node, result);
		return result;
	}

	/** True when evaluating the node reads documents: a regular expression or a scope. */
	private boolean isExpensive(Node node) {
		Boolean known = this.expensive.get(node);
		if (known != null) {
			return known;
		}
		boolean result = switch (node) {
			case Leaf leaf -> leaf.regex();
			case And and -> and.children().stream().anyMatch(this::isExpensive);
			case Or or -> or.children().stream().anyMatch(this::isExpensive);
			case Not not -> isExpensive(not.child());
			case Scoped scoped -> true;
		};
		this.expensive.put(node, result);
		return result;
	}

	// ---------------------------------------------------------------- results

	/** The word and phrase patterns that are not negated: they score hits and are highlighted. */
	List<TermPattern> positivePatterns() {
		List<TermPattern> patterns = new ArrayList<>();
		for (Leaf leaf : this.query.leaves()) {
			LeafState state = state(leaf);
			if (!state.negated && state.pattern != null) {
				patterns.add(state.pattern);
			}
		}
		return patterns;
	}

	/** The regular expressions over the text that are not negated: they are highlighted. */
	List<Pattern> positiveRegexes() {
		List<Pattern> regexes = new ArrayList<>();
		for (Leaf leaf : this.query.leaves()) {
			LeafState state = state(leaf);
			if (!state.negated && leaf.kind() == Kind.REGEX && state.regex != null) {
				regexes.add(state.regex);
			}
		}
		return regexes;
	}

	List<Correction> corrections() {
		List<Correction> result = new ArrayList<>();
		this.corrections.forEach((term, replacements) -> result.add(new Correction(term, replacements)));
		return Collections.unmodifiableList(result);
	}

	SearchRegex.Budget budget() {
		return this.budget;
	}

	Options options() {
		return this.options;
	}

}
