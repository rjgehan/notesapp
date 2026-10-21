package com.rjgehan.notes.flashcards;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.FlashcardCard;
import com.rjgehan.notes.api.dto.FlashcardCardState;
import com.rjgehan.notes.api.dto.FlashcardConfig;
import com.rjgehan.notes.api.error.FieldError;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The model and the exact layout of {@code .notesapp/srs.json} (DESIGN §5.34). Reading is tolerant: an entry that
 * cannot be read is skipped with a warning, and fields this build does not know are kept and written back. Writing is
 * byte-stable: cards sorted by id, one review per line, and a card's state on one line, so a review adds one line and
 * changes one, and git diffs and merges stay readable.
 */
final class SrsFile {

	private static final Logger logger = LoggerFactory.getLogger(SrsFile.class);

	static final int SCHEMA_VERSION = 1;

	static final Pattern CARD_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

	static final Pattern STEP = Pattern.compile("[0-9]{1,5}(\\.[0-9]{1,3})?[mhd]");

	static final Pattern TAG = Pattern.compile("[^\\s#,]{1,100}");

	/** The start of a question kept as a hint, in characters. */
	static final int MAX_FRONT = 200;

	static final int MAX_NOTE = 1024;

	/** One card's record. */
	static final class Card {

		@Nullable String note;

		@Nullable String front;

		@Nullable FlashcardCardState state;

		final TreeMap<Instant, ReviewEntry> reviews = new TreeMap<>();

		/** Fields this build does not know, kept in order. */
		final Map<String, JsonNode> extra = new LinkedHashMap<>();

		/** True when {@code s} was computed from exactly these reviews. */
		boolean matches(FlashcardCardState s) {
			Instant last = this.reviews.isEmpty() ? null : this.reviews.lastKey();
			return s.n() == this.reviews.size() && Objects.equals(s.lastReview(), last);
		}

		/** Drops a state that no longer describes the reviews. */
		void settle() {
			if (this.state != null && !matches(this.state)) {
				this.state = null;
			}
		}

		FlashcardCard toDto() {
			List<String> list = new ArrayList<>(this.reviews.size());
			for (ReviewEntry review : this.reviews.values()) {
				list.add(review.format());
			}
			return new FlashcardCard(this.note, this.front, this.state, list);
		}

	}

	/** Top-level fields this build does not know. */
	final Map<String, JsonNode> extra = new LinkedHashMap<>();

	/** The settings as stored: only the fields that were set, plus unknown ones. */
	final TreeMap<String, JsonNode> config = new TreeMap<>();

	final TreeMap<String, Card> cards = new TreeMap<>();

	// ---------------------------------------------------------------- reading

	static SrsFile parse(String text, JsonMapper mapper) {
		SrsFile file = new SrsFile();
		JsonNode root;
		try {
			root = mapper.readTree(text);
		}
		catch (JacksonException ex) {
			logger.warn("{} is not valid JSON; it is read as empty and replaced on the next review",
					FlashcardService.FILE);
			return file;
		}
		if (!(root instanceof ObjectNode object)) {
			logger.warn("{} is not a JSON object; it is read as empty", FlashcardService.FILE);
			return file;
		}
		for (Map.Entry<String, JsonNode> field : object.properties()) {
			switch (field.getKey()) {
				case "schemaVersion" -> {
					if (field.getValue().asInt(0) > SCHEMA_VERSION) {
						logger.warn("{} has schemaVersion {}; fields this build does not know are kept",
								FlashcardService.FILE, field.getValue().asInt(0));
					}
				}
				case "config" -> {
					if (field.getValue() instanceof ObjectNode config) {
						for (Map.Entry<String, JsonNode> entry : config.properties()) {
							file.config.put(entry.getKey(), entry.getValue());
						}
					}
				}
				case "cards" -> {
					if (field.getValue() instanceof ObjectNode cards) {
						for (Map.Entry<String, JsonNode> entry : cards.properties()) {
							Card card = (CARD_ID.matcher(entry.getKey()).matches()) ? parseCard(entry.getValue(), mapper)
									: null;
							if (card == null) {
								logger.warn("{}: the record of card {} cannot be read and is skipped",
										FlashcardService.FILE, entry.getKey());
							}
							else {
								file.cards.put(entry.getKey(), card);
							}
						}
					}
				}
				default -> file.extra.put(field.getKey(), field.getValue());
			}
		}
		return file;
	}

	private static @Nullable Card parseCard(JsonNode node, JsonMapper mapper) {
		if (!(node instanceof ObjectNode object)) {
			return null;
		}
		Card card = new Card();
		for (Map.Entry<String, JsonNode> field : object.properties()) {
			JsonNode value = field.getValue();
			switch (field.getKey()) {
				case "note" -> card.note = value.isString() ? value.asString() : null;
				case "front" -> card.front = value.isString() ? value.asString() : null;
				case "state" -> card.state = readState(value, mapper);
				case "reviews" -> {
					if (value.isArray()) {
						for (JsonNode item : value) {
							ReviewEntry review = item.isString() ? ReviewEntry.parse(item.asString()) : null;
							if (review != null) {
								card.reviews.putIfAbsent(review.at(), review);
							}
						}
					}
				}
				default -> card.extra.put(field.getKey(), value);
			}
		}
		card.settle();
		return card;
	}

	private static @Nullable FlashcardCardState readState(JsonNode value, JsonMapper mapper) {
		if (!value.isObject()) {
			return null;
		}
		try {
			FlashcardCardState state = mapper.treeToValue(value, FlashcardCardState.class);
			return (state != null && validState(state)) ? state : null;
		}
		catch (JacksonException | IllegalArgumentException ex) {
			return null;
		}
	}

	/** Finite, in-range numbers; the state is a cache, so an odd one is dropped rather than refused when read. */
	static boolean validState(FlashcardCardState s) {
		return Double.isFinite(s.stability()) && s.stability() >= 0 && s.stability() <= 1e7
				&& Double.isFinite(s.difficulty()) && s.difficulty() >= 0 && s.difficulty() <= 100
				&& s.scheduledDays() >= 0 && s.learningSteps() >= 0 && s.reps() >= 0 && s.lapses() >= 0 && s.n() >= 0
				&& s.due() != null && s.phase() != null;
	}

	// ---------------------------------------------------------------- settings

	/** The effective settings: every stored field that is valid, the default for the others. */
	FlashcardConfig resolvedConfig() {
		FlashcardConfig d = FlashcardConfig.DEFAULTS;
		List<FieldError> ignored = new ArrayList<>();
		return new FlashcardConfig(tags(this.config.get("tags"), d.tags(), ignored),
				bool(this.config.get("foldersAsDecks"), d.foldersAsDecks()),
				integer(this.config.get("newPerDay"), 0, 9999, d.newPerDay(), "newPerDay", ignored),
				integer(this.config.get("reviewsPerDay"), 0, 99999, d.reviewsPerDay(), "reviewsPerDay", ignored),
				retention(this.config.get("retention"), d.retention(), ignored),
				integer(this.config.get("maximumInterval"), 1, 36500, d.maximumInterval(), "maximumInterval", ignored),
				steps(this.config.get("learningSteps"), d.learningSteps(), "learningSteps", ignored),
				steps(this.config.get("relearningSteps"), d.relearningSteps(), "relearningSteps", ignored),
				bool(this.config.get("fuzz"), d.fuzz()),
				integer(this.config.get("dayStartsAt"), 0, 23, d.dayStartsAt(), "dayStartsAt", ignored));
	}

	/**
	 * Validates a settings change; every invalid field is reported. A {@code null} value resets the field to its
	 * default; fields this build does not know are ignored.
	 */
	static List<FieldError> validateUpdate(ObjectNode update) {
		List<FieldError> errors = new ArrayList<>();
		for (Map.Entry<String, JsonNode> field : update.properties()) {
			JsonNode value = field.getValue();
			if (value.isNull()) {
				continue;
			}
			String key = field.getKey();
			switch (key) {
				case "tags" -> tags(value, List.of(), errors);
				case "foldersAsDecks", "fuzz" -> {
					if (!value.isBoolean()) {
						errors.add(new FieldError("config." + key, "must be true or false"));
					}
				}
				case "newPerDay" -> integer(value, 0, 9999, 0, key, errors);
				case "reviewsPerDay" -> integer(value, 0, 99999, 0, key, errors);
				case "maximumInterval" -> integer(value, 1, 36500, 0, key, errors);
				case "dayStartsAt" -> integer(value, 0, 23, 0, key, errors);
				case "retention" -> retention(value, 0, errors);
				case "learningSteps", "relearningSteps" -> steps(value, List.of(), key, errors);
				default -> {
					// Unknown request fields are ignored (API.md §1.2).
				}
			}
		}
		return errors;
	}

	/** Applies a validated change: known fields are set, or removed when null. */
	void applyUpdate(ObjectNode update) {
		for (Map.Entry<String, JsonNode> field : update.properties()) {
			if (!FlashcardService.CONFIG_FIELDS.contains(field.getKey())) {
				continue;
			}
			if (field.getValue().isNull()) {
				this.config.remove(field.getKey());
			}
			else if (field.getKey().equals("tags")) {
				// Stored without the leading '#', as they are matched.
				ArrayNode tags = JsonNodeFactory.instance.arrayNode();
				tags(field.getValue(), List.of(), new ArrayList<>()).forEach(tags::add);
				this.config.put("tags", tags);
			}
			else {
				this.config.put(field.getKey(), field.getValue());
			}
		}
	}

	private static List<String> tags(@Nullable JsonNode value, List<String> fallback, List<FieldError> errors) {
		if (value == null) {
			return fallback;
		}
		if (!value.isArray() || value.isEmpty() || value.size() > 20) {
			errors.add(new FieldError("config.tags", "must list 1 to 20 tags"));
			return fallback;
		}
		List<String> tags = new ArrayList<>();
		for (JsonNode item : value) {
			String tag = item.isString() ? item.asString().strip() : "";
			if (tag.startsWith("#")) {
				tag = tag.substring(1);
			}
			if (!TAG.matcher(tag).matches()) {
				errors.add(new FieldError("config.tags", "must be tags without spaces, such as flashcards"));
				return fallback;
			}
			tags.add(tag);
		}
		return List.copyOf(tags);
	}

	private static boolean bool(@Nullable JsonNode value, boolean fallback) {
		return (value != null && value.isBoolean()) ? value.asBoolean() : fallback;
	}

	private static int integer(@Nullable JsonNode value, int min, int max, int fallback, String name,
			List<FieldError> errors) {
		if (value == null) {
			return fallback;
		}
		if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < min || value.asInt() > max) {
			errors.add(new FieldError("config." + name, "must be a whole number from " + min + " to " + max));
			return fallback;
		}
		return value.asInt();
	}

	private static double retention(@Nullable JsonNode value, double fallback, List<FieldError> errors) {
		if (value == null) {
			return fallback;
		}
		double r = value.isNumber() ? value.asDouble() : Double.NaN;
		if (!(r >= 0.7 && r <= 0.99)) {
			errors.add(new FieldError("config.retention", "must be from 0.7 to 0.99"));
			return fallback;
		}
		return r;
	}

	private static List<String> steps(@Nullable JsonNode value, List<String> fallback, String name,
			List<FieldError> errors) {
		if (value == null) {
			return fallback;
		}
		if (!value.isArray() || value.size() > 10) {
			errors.add(new FieldError("config." + name, "must list at most 10 steps such as 1m, 10m or 1d"));
			return fallback;
		}
		List<String> steps = new ArrayList<>();
		for (JsonNode item : value) {
			String step = item.isString() ? item.asString() : "";
			if (!STEP.matcher(step).matches()) {
				errors.add(new FieldError("config." + name, "must list at most 10 steps such as 1m, 10m or 1d"));
				return fallback;
			}
			steps.add(step);
		}
		return List.copyOf(steps);
	}

	// ---------------------------------------------------------------- writing

	byte[] serialize(JsonMapper mapper) {
		StringBuilder out = new StringBuilder(256 + this.cards.size() * 256);
		out.append("{\n  \"schemaVersion\": ").append(SCHEMA_VERSION).append(',');
		for (Map.Entry<String, JsonNode> field : this.extra.entrySet()) {
			out.append("\n  ").append(string(field.getKey(), mapper)).append(": ").append(compact(field.getValue(), mapper))
				.append(',');
		}
		out.append("\n  \"config\": {");
		Iterator<Map.Entry<String, JsonNode>> config = this.config.entrySet().iterator();
		while (config.hasNext()) {
			Map.Entry<String, JsonNode> field = config.next();
			out.append("\n    ").append(string(field.getKey(), mapper)).append(": ").append(compact(field.getValue(), mapper));
			out.append(config.hasNext() ? "," : "\n  ");
		}
		out.append("},\n  \"cards\": {");
		Iterator<Map.Entry<String, Card>> cards = this.cards.entrySet().iterator();
		while (cards.hasNext()) {
			Map.Entry<String, Card> entry = cards.next();
			Card card = entry.getValue();
			out.append("\n    ").append(string(entry.getKey(), mapper)).append(": {");
			List<String> fields = new ArrayList<>();
			if (card.note != null) {
				fields.add("\"note\": " + string(card.note, mapper));
			}
			if (card.front != null) {
				fields.add("\"front\": " + string(card.front, mapper));
			}
			if (card.state != null) {
				fields.add("\"state\": " + mapper.writeValueAsString(card.state));
			}
			for (Map.Entry<String, JsonNode> field : card.extra.entrySet()) {
				fields.add(string(field.getKey(), mapper) + ": " + compact(field.getValue(), mapper));
			}
			StringBuilder reviews = new StringBuilder("\"reviews\": [");
			Iterator<ReviewEntry> it = card.reviews.values().iterator();
			while (it.hasNext()) {
				reviews.append("\n        ").append(string(it.next().format(), mapper));
				reviews.append(it.hasNext() ? "," : "\n      ");
			}
			reviews.append(']');
			fields.add(reviews.toString());
			for (int i = 0; i < fields.size(); i++) {
				out.append("\n      ").append(fields.get(i)).append((i < fields.size() - 1) ? "," : "");
			}
			out.append("\n    }").append(cards.hasNext() ? "," : "\n  ");
		}
		out.append("}\n}\n");
		return out.toString().getBytes(StandardCharsets.UTF_8);
	}

	private static String string(String value, JsonMapper mapper) {
		return mapper.writeValueAsString(value);
	}

	private static String compact(JsonNode value, JsonMapper mapper) {
		return mapper.writeValueAsString(value);
	}

}
