package com.rjgehan.notes.flashcards;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.FlashcardCard;
import com.rjgehan.notes.api.dto.FlashcardCardState;
import com.rjgehan.notes.api.dto.FlashcardConfig;
import com.rjgehan.notes.api.dto.FlashcardNote;
import com.rjgehan.notes.api.dto.FlashcardNotesResponse;
import com.rjgehan.notes.api.dto.FlashcardReview;
import com.rjgehan.notes.api.dto.FlashcardWriteResult;
import com.rjgehan.notes.api.dto.FlashcardsResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FlashcardsChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Flashcard review records and settings (ROADMAP item 34, DESIGN §5.34, API.md §34), in {@code .notesapp/srs.json}.
 * <p>
 * The cards themselves live in notes and are parsed by the client. The server keeps what the notes do not hold: per
 * card, the set of answers (the truth) and the FSRS state a client computed from them (a cache, kept only while it
 * matches the answers). Every change is an operation applied under one lock to the file as it is on disk, so two
 * devices reviewing at once never conflict: their answers are united, and a state that no longer covers every answer
 * is dropped for the clients to recompute. Writes are committed with the vault's history and announced as
 * {@code flashcards.changed}.
 */
@Service
public class FlashcardService {

	private static final Logger logger = LoggerFactory.getLogger(FlashcardService.class);

	public static final String FILE = ".notesapp/srs.json";

	private static final ApiPath PATH = ApiPath.of(FILE);

	static final Set<String> CONFIG_FIELDS = Set.of("tags", "foldersAsDecks", "newPerDay", "reviewsPerDay",
			"retention", "maximumInterval", "learningSteps", "relearningSteps", "fuzz", "dayStartsAt");

	/** Answers in one request. */
	public static final int MAX_REVIEWS = 1000;

	/** Records named in one prune. */
	public static final int MAX_PRUNE = 10_000;

	/** Records listed in one event; more and the event asks clients to refetch. */
	static final int MAX_EVENT_CARDS = 20;

	/** How far ahead of the server's clock an answer may be dated (device clocks drift). */
	static final Duration MAX_CLOCK_SKEW = Duration.ofDays(1);

	private final VaultFs fs;

	private final VaultIndex index;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final JsonMapper mapper;

	private final Clock clock;

	private final ReentrantLock lock = new ReentrantLock();

	/** The file as last read or written, and its blob id; re-read whenever the disk differs. */
	private @Nullable SrsFile cached;

	private @Nullable String cachedVersion;

	public FlashcardService(VaultFs fs, VaultIndex index, CommitBatcher batcher, EventHub hub, JsonMapper mapper,
			Clock clock) {
		this.fs = fs;
		this.index = index;
		this.batcher = batcher;
		this.hub = hub;
		this.mapper = mapper;
		this.clock = clock;
	}

	// ---------------------------------------------------------------- reads

	/** {@code GET /api/flashcards}. */
	public FlashcardsResponse state() throws IOException {
		lock();
		try {
			SrsFile file = load();
			Map<String, FlashcardCard> cards = new LinkedHashMap<>();
			for (Map.Entry<String, SrsFile.Card> entry : file.cards.entrySet()) {
				cards.put(entry.getKey(), entry.getValue().toDto());
			}
			return new FlashcardsResponse(file.resolvedConfig(), cards, this.cachedVersion);
		}
		finally {
			this.lock.unlock();
		}
	}

	public FlashcardConfig config() throws IOException {
		lock();
		try {
			return load().resolvedConfig();
		}
		finally {
			this.lock.unlock();
		}
	}

	/**
	 * {@code GET /api/flashcards/notes}: the notes that may hold cards, with their text. With tags, the notes carrying
	 * one of them (or a nested tag) anywhere; with {@code foldersAsDecks}, every note with a card marker.
	 */
	public FlashcardNotesResponse notes() throws IOException {
		FlashcardConfig config = config();
		Set<String> paths = new TreeSet<>();
		if (config.foldersAsDecks()) {
			for (FileRecord record : this.index.files((r) -> r.kind() == FileKind.NOTE)) {
				paths.add(record.path());
			}
		}
		else {
			for (String tag : config.tags()) {
				paths.addAll(this.index.notesWithTag(tag, true));
			}
		}
		List<FlashcardNote> notes = new ArrayList<>();
		for (String path : paths) {
			// Drawings are notes another view shows; their indexed text carries the drawing's supplement.
			if (!path.endsWith(".md") || path.endsWith(".excalidraw.md")) {
				continue;
			}
			NoteRecord note = this.index.note(path);
			if (note == null || (config.foldersAsDecks() && !hasCardMarker(note.text()))) {
				continue;
			}
			notes.add(new FlashcardNote(path, note.version(), note.text()));
		}
		return new FlashcardNotesResponse(config, notes);
	}

	/** A quick filter: {@code ::}, a highlight, or a line that is only {@code ?} or {@code ??}. */
	static boolean hasCardMarker(String text) {
		if (text.contains("::") || text.contains("==")) {
			return true;
		}
		for (String line : text.split("\n", -1)) {
			String trimmed = line.strip();
			if (trimmed.equals("?") || trimmed.equals("??")) {
				return true;
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- writes

	/** {@code POST /api/flashcards/reviews}: unites the answers with each card's record. */
	public FlashcardWriteResult review(@Nullable List<FlashcardReview> reviews, Identity identity,
			@Nullable String origin) throws IOException {
		if (reviews == null || reviews.isEmpty() || reviews.size() > MAX_REVIEWS) {
			throw NotesException.badRequest("reviews must list 1 to " + MAX_REVIEWS + " answers");
		}
		List<ValidReview> valid = new ArrayList<>(reviews.size());
		List<FieldError> errors = new ArrayList<>();
		Instant latest = this.clock.instant().plus(MAX_CLOCK_SKEW);
		for (int i = 0; i < reviews.size(); i++) {
			ValidReview v = validate(reviews.get(i), "reviews[" + i + "].", latest, errors);
			if (v != null) {
				valid.add(v);
			}
		}
		throwIfInvalid(errors, "Invalid review");
		return write(identity, origin, (file, changed) -> {
			for (ValidReview v : valid) {
				SrsFile.Card card = file.cards.get(v.card());
				if (v.from() != null && !v.from().equals(v.card())) {
					SrsFile.Card old = file.cards.remove(v.from());
					if (old != null) {
						changed.put(v.from(), null);
						if (card == null) {
							card = old;
						}
						else {
							old.reviews.forEach(card.reviews::putIfAbsent);
						}
						file.cards.put(v.card(), card);
					}
				}
				if (card == null) {
					card = new SrsFile.Card();
					file.cards.put(v.card(), card);
				}
				card.reviews.putIfAbsent(v.entry().at(), v.entry());
				if (v.note() != null) {
					card.note = v.note();
				}
				if (v.front() != null) {
					card.front = v.front();
				}
				if (v.state() != null && card.matches(v.state())) {
					card.state = v.state();
				}
				card.settle();
				changed.put(v.card(), card);
			}
		});
	}

	/** {@code POST /api/flashcards/undo}: removes one answer; a record left without answers is removed. */
	public FlashcardWriteResult undo(@Nullable String cardId, @Nullable String at, @Nullable FlashcardCardState state,
			Identity identity, @Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		if (cardId == null || !SrsFile.CARD_ID.matcher(cardId).matches()) {
			errors.add(new FieldError("card", "must be a card id"));
		}
		Instant time = ReviewEntry.parseInstant(at);
		if (time == null) {
			errors.add(new FieldError("at", "must be an ISO-8601 instant"));
		}
		if (state != null && !SrsFile.validState(state)) {
			errors.add(new FieldError("state", "is not a valid card state"));
		}
		throwIfInvalid(errors, "Invalid undo");
		return write(identity, origin, (file, changed) -> {
			SrsFile.Card card = file.cards.get(cardId);
			if (card == null || card.reviews.remove(time.truncatedTo(ChronoUnit.MILLIS)) == null) {
				return;
			}
			if (card.reviews.isEmpty()) {
				file.cards.remove(cardId);
				changed.put(cardId, null);
				return;
			}
			if (state != null && card.matches(state)) {
				card.state = state;
			}
			card.settle();
			changed.put(cardId, card);
		});
	}

	/** {@code POST /api/flashcards/prune}: forgets the named records. */
	public FlashcardWriteResult prune(@Nullable List<String> ids, Identity identity, @Nullable String origin)
			throws IOException {
		if (ids == null || ids.isEmpty() || ids.size() > MAX_PRUNE) {
			throw NotesException.badRequest("cards must list 1 to " + MAX_PRUNE + " card ids");
		}
		return write(identity, origin, (file, changed) -> {
			for (String id : ids) {
				if (id != null && file.cards.remove(id) != null) {
					changed.put(id, null);
				}
			}
		});
	}

	/** {@code PUT /api/flashcards/config}: changes the given settings, keeps the others. */
	public FlashcardConfig updateConfig(@Nullable JsonNode update, Identity identity, @Nullable String origin)
			throws IOException {
		if (!(update instanceof ObjectNode object)) {
			throw NotesException.badRequest("config must be an object");
		}
		throwIfInvalid(SrsFile.validateUpdate(object), "Invalid flashcard settings");
		FlashcardConfig[] result = new FlashcardConfig[1];
		write(identity, origin, (file, changed) -> {
			file.applyUpdate(object);
			result[0] = file.resolvedConfig();
		}, true);
		return result[0];
	}

	// ---------------------------------------------------------------- internals

	private record ValidReview(String card, ReviewEntry entry, @Nullable String note, @Nullable String front,
			@Nullable FlashcardCardState state, @Nullable String from) {
	}

	private static @Nullable ValidReview validate(FlashcardReview r, String prefix, Instant latest,
			List<FieldError> errors) {
		int before = errors.size();
		if (r.card() == null || !SrsFile.CARD_ID.matcher(r.card()).matches()) {
			errors.add(new FieldError(prefix + "card", "must be 1 to 64 letters, digits, - or _"));
		}
		Instant at = ReviewEntry.parseInstant(r.at());
		if (at == null) {
			errors.add(new FieldError(prefix + "at", "must be an ISO-8601 instant"));
		}
		else if (at.isAfter(latest)) {
			errors.add(new FieldError(prefix + "at", "is more than a day ahead of the server's clock"));
		}
		if (r.rating() == null || !ReviewEntry.RATINGS.contains(r.rating())) {
			errors.add(new FieldError(prefix + "rating", "must be again, hard, good, easy or reset"));
		}
		if (r.ms() != null && (r.ms() < 0 || r.ms() > ReviewEntry.MAX_MS)) {
			errors.add(new FieldError(prefix + "ms", "must be from 0 to " + ReviewEntry.MAX_MS));
		}
		if (r.note() != null && (r.note().isBlank() || r.note().length() > SrsFile.MAX_NOTE)) {
			errors.add(new FieldError(prefix + "note", "must be a vault path"));
		}
		if (r.from() != null && !SrsFile.CARD_ID.matcher(r.from()).matches()) {
			errors.add(new FieldError(prefix + "from", "must be a card id"));
		}
		if (r.state() != null && !SrsFile.validState(r.state())) {
			errors.add(new FieldError(prefix + "state", "is not a valid card state"));
		}
		if (errors.size() > before || at == null || r.card() == null || r.rating() == null) {
			return null;
		}
		return new ValidReview(r.card(), new ReviewEntry(at, r.rating(), r.ms()), r.note(), front(r.front()),
				r.state(), r.from());
	}

	/** The start of a question, on one line, as a hint for people reading the file. */
	private static @Nullable String front(@Nullable String text) {
		if (text == null) {
			return null;
		}
		String line = text.replaceAll("\\s+", " ").strip();
		if (line.length() > SrsFile.MAX_FRONT) {
			int end = SrsFile.MAX_FRONT;
			if (Character.isHighSurrogate(line.charAt(end - 1))) {
				end--;
			}
			line = line.substring(0, end) + "…";
		}
		return line.isEmpty() ? null : line;
	}

	private static void throwIfInvalid(List<FieldError> errors, String what) {
		if (!errors.isEmpty()) {
			throw new NotesException(ErrorCode.BAD_REQUEST,
					what + ": " + errors.get(0).field() + " " + errors.get(0).message(), Map.of("errors", errors));
		}
	}

	@FunctionalInterface
	private interface Change {

		/** Changes {@code file}; records each changed card in {@code changed} (null when removed). */
		void apply(SrsFile file, Map<String, SrsFile.@Nullable Card> changed);

	}

	private FlashcardWriteResult write(Identity identity, @Nullable String origin, Change change) throws IOException {
		return write(identity, origin, change, false);
	}

	private FlashcardWriteResult write(Identity identity, @Nullable String origin, Change change, boolean config)
			throws IOException {
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				SrsFile file = load();
				Map<String, SrsFile.@Nullable Card> changed = new LinkedHashMap<>();
				byte[] before = file.serialize(this.mapper);
				change.apply(file, changed);
				byte[] bytes = file.serialize(this.mapper);
				String version = Hashing.blobId(bytes);
				Map<String, @Nullable FlashcardCard> cards = new LinkedHashMap<>();
				changed.forEach((id, card) -> cards.put(id, (card != null) ? card.toDto() : null));
				if (Arrays.equals(before, bytes)) {
					return new FlashcardWriteResult(cards, version);
				}
				Author author = Author.of(identity);
				this.batcher.prepareWrite(author);
				try {
					Files.createDirectories(this.fs.resolve(FILE).getParent());
					this.fs.atomicWrite(FILE, bytes);
				}
				catch (IOException | RuntimeException ex) {
					// The model was changed in place; the disk is the truth again.
					this.cached = null;
					this.cachedVersion = null;
					throw ex;
				}
				this.cachedVersion = version;
				this.batcher.markDirty(PATH, author);
				this.hub.publish(new FlashcardsChangedEvent((cards.size() <= MAX_EVENT_CARDS) ? cards : null,
						config ? file.resolvedConfig() : null, version, origin));
				logger.info("FLASHCARDS {} ({} records) client={} user={}", config ? "settings saved" : "saved",
						changed.size(), origin, identity.login());
				return new FlashcardWriteResult(cards, version);
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	/** The file as it is on disk now: re-read when its bytes changed (a hand edit, a history restore). */
	private SrsFile load() throws IOException {
		byte[] disk;
		try {
			disk = this.fs.readBytes(FILE);
		}
		catch (NoSuchFileException ex) {
			disk = null;
		}
		String version = (disk != null) ? Hashing.blobId(disk) : null;
		if (this.cached != null && Objects.equals(version, this.cachedVersion)) {
			return this.cached;
		}
		SrsFile file = (disk != null) ? SrsFile.parse(TextCodec.decode(disk).text(), this.mapper) : new SrsFile();
		this.cached = file;
		this.cachedVersion = version;
		return file;
	}

	private void lock() {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
	}

}
