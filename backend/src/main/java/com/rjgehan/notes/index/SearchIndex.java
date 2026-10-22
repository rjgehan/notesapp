package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.function.IntPredicate;

import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * The full-text index of notes (DESIGN §5.5.10): per-field postings of normalized terms ({@link Tokenizer}), sorted
 * by document id, with term frequencies for BM25 ({@code k1=1.2}, {@code b=0.75}) and field weights title 4, aliases
 * 3, headings 2, tags 2, body 1. Every document keeps its term lists so it can be removed on update, and its token
 * sequences (two bytes per token) so phrases are verified without tokenizing notes again; a sorted vocabulary
 * supports prefix expansion. Not thread-safe: {@link VaultIndex} guards it with its lock; documents are
 * tokenized outside that lock ({@link Doc#of}).
 */
public final class SearchIndex {

	static final double K1 = 1.2;

	static final double B = 0.75;

	/** At most this many vocabulary terms are tried for one prefix. */
	static final int MAX_EXPANSIONS = 64;

	public enum Field {

		TITLE(4), ALIASES(3), HEADINGS(2), TAGS(2), BODY(1);

		final double weight;

		Field(double weight) {
			this.weight = weight;
		}

	}

	private static final Field[] FIELDS = Field.values();

	/** A phrase is checked against the kept token sequences only up to this many terms (one bit per term). */
	private static final int MAX_SEQUENCE_PHRASE = Long.SIZE;

	/**
	 * One field of a tokenized note: its distinct terms in order of first appearance, their frequencies, its length in
	 * tokens, and the token sequence as indexes into {@code terms}. The sequence is null when the field has more
	 * distinct terms than a {@code char} can index.
	 */
	private record FieldTerms(String[] terms, int[] frequencies, int length, char @Nullable [] sequence) {

		static FieldTerms of(List<Tokenizer.Token> tokens) {
			Map<String, Integer> index = new HashMap<>();
			List<String> terms = new ArrayList<>();
			int[] frequencies = new int[Math.max(1, tokens.size())];
			char[] sequence = new char[tokens.size()];
			for (int k = 0; k < tokens.size(); k++) {
				String term = tokens.get(k).term();
				Integer local = index.get(term);
				if (local == null) {
					local = terms.size();
					index.put(term, local);
					terms.add(term);
				}
				frequencies[local]++;
				sequence[k] = (char) local.intValue();
			}
			boolean indexable = terms.size() <= Character.MAX_VALUE + 1;
			return new FieldTerms(terms.toArray(String[]::new), Arrays.copyOf(frequencies, terms.size()), tokens.size(),
					indexable ? sequence : null);
		}

	}

	/** A note's terms with their frequencies and token sequences per field, built outside the index lock. */
	public static final class Doc {

		private final FieldTerms[] fields;

		private final int[] lineTokens;

		private Doc(FieldTerms[] fields, int[] lineTokens) {
			this.fields = fields;
			this.lineTokens = lineTokens;
		}

		/** Tokenizes a note: {@code basename} is its title, {@code text} its BOM-stripped content. */
		public static Doc of(String basename, String text, NoteParse parse) {
			List<List<Tokenizer.Token>> tokens = fieldTokens(basename, text, parse);
			FieldTerms[] fields = new FieldTerms[FIELDS.length];
			for (int f = 0; f < FIELDS.length; f++) {
				fields[f] = FieldTerms.of(tokens.get(f));
			}
			return new Doc(fields, lineTokens(tokens.get(Field.BODY.ordinal()), parse.lineStarts()));
		}

	}

	/**
	 * For every line, the index of the first body token at or after its start, plus the token count at the end, so
	 * line {@code i} holds body tokens {@code [lineTokens[i], lineTokens[i + 1])}. Lines of the frontmatter hold none.
	 */
	static int[] lineTokens(List<Tokenizer.Token> body, int[] lineStarts) {
		int[] starts = new int[lineStarts.length + 1];
		int t = 0;
		for (int line = 0; line < lineStarts.length; line++) {
			while (t < body.size() && body.get(t).from() < lineStarts[line]) {
				t++;
			}
			starts[line] = t;
		}
		starts[lineStarts.length] = body.size();
		return starts;
	}

	/**
	 * A document's body as the index keeps it: its distinct terms, its token sequence as indexes into them, and the
	 * token index at which each line starts ({@link #lineTokens}). The arrays are never changed once stored, so they
	 * may be read after the index lock is released.
	 */
	public record Body(String[] terms, char[] sequence, int[] lineTokens) {
	}

	/**
	 * What is kept per document: its path, the distinct terms of each field (for removal and phrases), the field
	 * lengths, and each field's token sequence as indexes into its terms, which lets phrases be checked without
	 * tokenizing the note again. {@code sequences} is null when a field had too many distinct terms to keep one.
	 */
	private static final class Stored {

		String path;

		final String[][] terms;

		final int[] lengths;

		final char @Nullable [][] sequences;

		final int[] lineTokens;

		Stored(String path, String[][] terms, int[] lengths, char @Nullable [][] sequences, int[] lineTokens) {
			this.path = path;
			this.terms = terms;
			this.lengths = lengths;
			this.sequences = sequences;
			this.lineTokens = lineTokens;
		}

	}

	/** Sorted document ids with term frequencies. */
	private static final class Postings {

		private int[] docs = new int[2];

		private int[] tfs = new int[2];

		private int size;

		void put(int doc, int tf) {
			int i = Arrays.binarySearch(this.docs, 0, this.size, doc);
			if (i >= 0) {
				this.tfs[i] = tf;
				return;
			}
			int at = -i - 1;
			if (this.size == this.docs.length) {
				this.docs = Arrays.copyOf(this.docs, this.size * 2);
				this.tfs = Arrays.copyOf(this.tfs, this.size * 2);
			}
			System.arraycopy(this.docs, at, this.docs, at + 1, this.size - at);
			System.arraycopy(this.tfs, at, this.tfs, at + 1, this.size - at);
			this.docs[at] = doc;
			this.tfs[at] = tf;
			this.size++;
		}

		void remove(int doc) {
			int i = Arrays.binarySearch(this.docs, 0, this.size, doc);
			if (i < 0) {
				return;
			}
			System.arraycopy(this.docs, i + 1, this.docs, i, this.size - i - 1);
			System.arraycopy(this.tfs, i + 1, this.tfs, i, this.size - i - 1);
			this.size--;
		}

		int tf(int doc) {
			int i = Arrays.binarySearch(this.docs, 0, this.size, doc);
			return (i >= 0) ? this.tfs[i] : 0;
		}

		void addTo(BitSet set) {
			for (int i = 0; i < this.size; i++) {
				set.set(this.docs[i]);
			}
		}

	}

	private final List<Map<String, Postings>> postings = new ArrayList<>(FIELDS.length);

	/** Every term of every field, with the number of fields whose postings contain it. */
	private final NavigableMap<String, Integer> vocabulary = new TreeMap<>();

	private final Map<Integer, Stored> docs = new HashMap<>();

	private final long[] totalLengths = new long[FIELDS.length];

	public SearchIndex() {
		for (int f = 0; f < FIELDS.length; f++) {
			this.postings.add(new HashMap<>());
		}
	}

	/** The token lists of each field, in {@link Field} order; offsets of the body refer to {@code text}. */
	public static List<List<Tokenizer.Token>> fieldTokens(String basename, String text, NoteParse parse) {
		List<Tokenizer.Token> aliases = new ArrayList<>();
		parse.aliases().forEach((alias) -> aliases.addAll(Tokenizer.tokenize(alias)));
		List<Tokenizer.Token> headings = new ArrayList<>();
		parse.headings().forEach((heading) -> headings.addAll(Tokenizer.tokenize(heading.text())));
		List<Tokenizer.Token> tags = new ArrayList<>();
		parse.distinctTags().forEach((tag) -> tags.addAll(Tokenizer.tokenize(tag)));
		return List.of(Tokenizer.tokenize(basename), aliases, headings, tags,
				Tokenizer.tokenize(EncryptedSections.blank(text), bodyStart(parse), text.length()));
	}

	/** The offset where the body starts: after the frontmatter, if any. */
	public static int bodyStart(NoteParse parse) {
		Frontmatter frontmatter = parse.frontmatter();
		return (frontmatter != null) ? frontmatter.to() : 0;
	}

	// ---------------------------------------------------------------- updates

	/** Adds a document, replacing any earlier one with the same id. */
	void add(int docId, String path, Doc doc) {
		remove(docId);
		String[][] terms = new String[FIELDS.length][];
		int[] lengths = new int[FIELDS.length];
		char[][] sequences = new char[FIELDS.length][];
		boolean sequenced = true;
		for (int f = 0; f < FIELDS.length; f++) {
			FieldTerms field = doc.fields[f];
			terms[f] = new String[field.terms().length];
			for (int i = 0; i < terms[f].length; i++) {
				terms[f][i] = addPosting(f, field.terms()[i], docId, field.frequencies()[i]);
			}
			lengths[f] = field.length();
			sequences[f] = field.sequence();
			sequenced &= field.sequence() != null;
			this.totalLengths[f] += lengths[f];
		}
		this.docs.put(docId, new Stored(path, terms, lengths, sequenced ? sequences : null, doc.lineTokens));
	}

	void remove(int docId) {
		Stored stored = this.docs.remove(docId);
		if (stored == null) {
			return;
		}
		for (int f = 0; f < FIELDS.length; f++) {
			for (String term : stored.terms[f]) {
				removePosting(f, term, docId);
			}
			this.totalLengths[f] -= stored.lengths[f];
		}
	}

	/** A moved note: the path changes, and the title terms when the basename changed. */
	void move(int docId, String path) {
		Stored stored = this.docs.get(docId);
		if (stored == null) {
			return;
		}
		String oldBasename = PathNames.basenameOf(PathNames.nameOf(stored.path));
		stored.path = path;
		String basename = PathNames.basenameOf(PathNames.nameOf(path));
		if (oldBasename.equals(basename)) {
			return;
		}
		int title = Field.TITLE.ordinal();
		for (String term : stored.terms[title]) {
			removePosting(title, term, docId);
		}
		this.totalLengths[title] -= stored.lengths[title];
		List<Tokenizer.Token> tokens = Tokenizer.tokenize(basename);
		FieldTerms field = FieldTerms.of(tokens);
		String[] terms = new String[field.terms().length];
		for (int i = 0; i < terms.length; i++) {
			terms[i] = addPosting(title, field.terms()[i], docId, field.frequencies()[i]);
		}
		stored.terms[title] = terms;
		stored.lengths[title] = tokens.size();
		this.totalLengths[title] += tokens.size();
		char[][] sequences = stored.sequences;
		if (sequences != null) {
			sequences[title] = field.sequence();
		}
	}

	void clear() {
		this.postings.forEach(Map::clear);
		this.vocabulary.clear();
		this.docs.clear();
		Arrays.fill(this.totalLengths, 0);
	}

	private String addPosting(int field, String term, int docId, int tf) {
		Postings list = this.postings.get(field).get(term);
		if (list == null) {
			list = new Postings();
			this.postings.get(field).put(term, list);
			this.vocabulary.merge(term, 1, Integer::sum);
		}
		list.put(docId, tf);
		// Share one String instance per term between the postings map and the per-document term lists.
		String canonical = this.vocabulary.ceilingKey(term);
		return (canonical != null && canonical.equals(term)) ? canonical : term;
	}

	private void removePosting(int field, String term, int docId) {
		Postings list = this.postings.get(field).get(term);
		if (list == null) {
			return;
		}
		list.remove(docId);
		if (list.size == 0) {
			this.postings.get(field).remove(term);
			this.vocabulary.computeIfPresent(term, (k, count) -> (count <= 1) ? null : count - 1);
		}
	}

	// ---------------------------------------------------------------- queries

	public int size() {
		return this.docs.size();
	}

	public @Nullable String path(int docId) {
		Stored stored = this.docs.get(docId);
		return (stored != null) ? stored.path : null;
	}

	/** Every indexed document. */
	public BitSet all() {
		BitSet set = new BitSet();
		this.docs.keySet().forEach(set::set);
		return set;
	}

	/**
	 * The vocabulary terms a pattern position can match: the term itself, or up to 64 terms it prefixes, plus its typo
	 * variants.
	 */
	public List<String> alternatives(TermPattern pattern, int index) {
		String term = pattern.terms().get(index);
		List<String> expanded = new ArrayList<>();
		if (!pattern.isPrefix(index)) {
			expanded.add(term);
		}
		else {
			for (String candidate : this.vocabulary.tailMap(term, true).navigableKeySet()) {
				if (!candidate.startsWith(term) || expanded.size() == MAX_EXPANSIONS) {
					break;
				}
				expanded.add(candidate);
			}
		}
		for (String variant : pattern.variants().get(index)) {
			if (!expanded.contains(variant)) {
				expanded.add(variant);
			}
		}
		return expanded;
	}

	/** True when some field of some document contains {@code term}. */
	public boolean hasTerm(String term) {
		return this.vocabulary.containsKey(term);
	}

	/** True when some vocabulary term starts with {@code prefix}. */
	public boolean hasPrefix(String prefix) {
		String next = this.vocabulary.ceilingKey(prefix);
		return next != null && next.startsWith(prefix);
	}

	/**
	 * Typo tolerance: up to {@code limit} vocabulary terms within {@code maxDistance} edits (insertions, deletions,
	 * substitutions and transpositions of adjacent characters) of {@code term}, closest first, then the most common.
	 */
	public List<String> similarTerms(String term, int maxDistance, int limit) {
		record Candidate(String term, int distance, int frequency) {
		}
		List<Candidate> found = new ArrayList<>();
		int length = term.length();
		for (String candidate : this.vocabulary.keySet()) {
			if (Math.abs(candidate.length() - length) > maxDistance || candidate.equals(term)) {
				continue;
			}
			int distance = Fuzzy.distance(term, candidate, maxDistance);
			if (distance <= maxDistance) {
				found.add(new Candidate(candidate, distance, documentFrequency(candidate)));
			}
		}
		found.sort(Comparator.comparingInt(Candidate::distance)
			.thenComparing(Comparator.comparingInt(Candidate::frequency).reversed())
			.thenComparing(Candidate::term));
		return found.stream().limit(limit).map(Candidate::term).toList();
	}

	/** The number of documents in the largest field postings of {@code term}. */
	private int documentFrequency(String term) {
		int frequency = 0;
		for (Map<String, Postings> field : this.postings) {
			Postings list = field.get(term);
			if (list != null) {
				frequency = Math.max(frequency, list.size);
			}
		}
		return frequency;
	}

	/** The body of a document, or null when it is unknown or its token sequences were too large to keep. */
	public @Nullable Body body(int docId) {
		Stored stored = this.docs.get(docId);
		if (stored == null || stored.sequences == null) {
			return null;
		}
		int body = Field.BODY.ordinal();
		return new Body(stored.terms[body], stored.sequences[body], stored.lineTokens);
	}

	/** For every term a position of {@code pattern} accepts, the bit mask of the positions it fills. */
	public Map<String, Long> positions(TermPattern pattern) {
		Map<String, Long> positions = new HashMap<>();
		int size = Math.min(pattern.terms().size(), MAX_SEQUENCE_PHRASE);
		for (int i = 0; i < size; i++) {
			long bit = 1L << i;
			for (String term : alternatives(pattern, i)) {
				positions.merge(term, bit, (a, b) -> a | b);
			}
		}
		return positions;
	}

	/** The longest pattern {@link #occurs(char[], long[], int, int, int)} can check. */
	public static int maxSequencePattern() {
		return MAX_SEQUENCE_PHRASE;
	}

	/**
	 * True when positions {@code 0..size-1} are filled by consecutive tokens of {@code sequence} between token
	 * {@code from} and {@code to}; {@code masks[j]} holds the positions that local term {@code j} fills.
	 */
	public static boolean occurs(char[] sequence, long[] masks, int size, int from, int to) {
		next: for (int start = from; start + size <= to; start++) {
			for (int k = 0; k < size; k++) {
				if ((masks[sequence[start + k]] & (1L << k)) == 0) {
					continue next;
				}
			}
			return true;
		}
		return false;
	}

	/** Documents containing every term of the pattern in some field (consecutiveness is checked separately). */
	public BitSet candidates(TermPattern pattern) {
		BitSet result = null;
		for (int i = 0; i < pattern.terms().size(); i++) {
			BitSet any = new BitSet();
			for (String term : alternatives(pattern, i)) {
				for (Map<String, Postings> field : this.postings) {
					Postings list = field.get(term);
					if (list != null) {
						list.addTo(any);
					}
				}
			}
			if (result == null) {
				result = any;
			}
			else {
				result.and(any);
			}
		}
		return (result != null) ? result : new BitSet();
	}

	/**
	 * Keeps the documents of {@code docs} in which the phrase occurs as consecutive tokens of one field, using the
	 * token sequences kept per document. {@code verify} decides for a document whose sequences are not kept, and for
	 * a phrase longer than {@value #MAX_SEQUENCE_PHRASE} terms.
	 */
	void retainPhrase(BitSet docs, TermPattern pattern, IntPredicate verify) {
		int size = pattern.terms().size();
		if (size > MAX_SEQUENCE_PHRASE) {
			for (int docId : docs.stream().toArray()) {
				if (!verify.test(docId)) {
					docs.clear(docId);
				}
			}
			return;
		}
		// For every term a position accepts, the bit mask of the phrase positions it fills.
		Map<String, Long> positions = positions(pattern);
		long[] masks = new long[64];
		for (int docId = docs.nextSetBit(0); docId >= 0; docId = docs.nextSetBit(docId + 1)) {
			Stored stored = this.docs.get(docId);
			boolean found;
			if (stored == null) {
				found = false;
			}
			else if (stored.sequences == null) {
				found = verify.test(docId);
			}
			else {
				found = false;
				for (int f = 0; f < FIELDS.length && !found; f++) {
					String[] terms = stored.terms[f];
					if (masks.length < terms.length) {
						masks = new long[terms.length];
					}
					for (int j = 0; j < terms.length; j++) {
						masks[j] = positions.getOrDefault(terms[j], 0L);
					}
					found = occurs(stored.sequences[f], masks, size);
				}
			}
			if (!found) {
				docs.clear(docId);
			}
		}
	}

	/** True when positions {@code 0..size-1} are filled by consecutive tokens of {@code sequence}. */
	private static boolean occurs(char[] sequence, long[] masks, int size) {
		return occurs(sequence, masks, size, 0, sequence.length);
	}

	/** Documents containing at least one of {@code terms} (exact terms) in any field: the OR of their postings. */
	public BitSet anyCandidates(List<String> terms) {
		BitSet result = new BitSet();
		for (String term : terms) {
			for (Map<String, Postings> field : this.postings) {
				Postings list = field.get(term);
				if (list != null) {
					list.addTo(result);
				}
			}
		}
		return result;
	}

	/** Documents whose body contains every one of {@code terms} (exact terms). */
	public BitSet bodyCandidates(List<String> terms) {
		BitSet result = null;
		Map<String, Postings> body = this.postings.get(Field.BODY.ordinal());
		for (String term : terms) {
			BitSet any = new BitSet();
			Postings list = body.get(term);
			if (list != null) {
				list.addTo(any);
			}
			if (result == null) {
				result = any;
			}
			else {
				result.and(any);
			}
		}
		return (result != null) ? result : new BitSet();
	}

	/**
	 * The BM25 score of a document for some patterns: for every pattern position, the best of its alternatives summed
	 * over the weighted fields.
	 */
	public double score(int docId, List<TermPattern> patterns) {
		Stored stored = this.docs.get(docId);
		if (stored == null) {
			return 0;
		}
		double score = 0;
		for (TermPattern pattern : patterns) {
			for (int i = 0; i < pattern.terms().size(); i++) {
				double best = 0;
				for (String term : alternatives(pattern, i)) {
					best = Math.max(best, termScore(docId, stored, term));
				}
				score += best;
			}
		}
		return score;
	}

	private double termScore(int docId, Stored stored, String term) {
		int n = this.docs.size();
		double score = 0;
		for (int f = 0; f < FIELDS.length; f++) {
			Postings list = this.postings.get(f).get(term);
			if (list == null) {
				continue;
			}
			int tf = list.tf(docId);
			if (tf == 0) {
				continue;
			}
			double idf = Math.log(1 + (n - list.size + 0.5) / (list.size + 0.5));
			double average = (n == 0) ? 1 : Math.max(1e-9, (double) this.totalLengths[f] / n);
			double norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * stored.lengths[f] / average));
			score += FIELDS[f].weight * idf * norm;
		}
		return score;
	}

}
