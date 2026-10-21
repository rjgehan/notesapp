package com.rjgehan.notes.flashcards;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.FlashcardCardState;
import com.rjgehan.notes.api.dto.FlashcardConfig;
import com.rjgehan.notes.api.dto.FlashcardPhase;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.config.JsonConfig;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;

/** The layout and the tolerant reading of {@code .notesapp/srs.json} (DESIGN §5.34). */
class SrsFileTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().addModule(JsonConfig.notesModule()).build();

	private static final String SAMPLE = """
			{
			  "schemaVersion": 1,
			  "future": {"x":1},
			  "config": {
			    "newPerDay": 10,
			    "someday": true,
			    "tags": ["flashcards","srs"]
			  },
			  "cards": {
			    "c1abc": {
			      "note": "Biology/Cells.md",
			      "front": "Powerhouse of the cell?",
			      "state": {"due":"2026-10-24T09:00:00.000Z","stability":3.1262,"difficulty":5.3,"scheduledDays":3,"learningSteps":0,"reps":2,"lapses":0,"phase":"review","lastReview":"2026-10-21T09:00:00.000Z","n":2},
			      "color": "red",
			      "reviews": [
			        "2026-10-19T08:12:03.123Z good 5200",
			        "2026-10-21T09:00:00.000Z good"
			      ]
			    },
			    "c2def": {
			      "reviews": [
			        "2026-10-20T10:00:00.000Z again"
			      ]
			    }
			  }
			}
			""";

	private static SrsFile parse(String text) {
		return SrsFile.parse(text, MAPPER);
	}

	private static String write(SrsFile file) {
		return new String(file.serialize(MAPPER), StandardCharsets.UTF_8);
	}

	@Test
	void theLayoutIsByteStableAndKeepsUnknownFields() {
		SrsFile file = parse(SAMPLE);
		assertThat(write(file)).isEqualTo(SAMPLE);
		assertThat(file.cards).containsOnlyKeys("c1abc", "c2def");
		assertThat(file.cards.get("c1abc").state).isNotNull();
		assertThat(file.cards.get("c1abc").toDto().reviews()).containsExactly("2026-10-19T08:12:03.123Z good 5200",
				"2026-10-21T09:00:00.000Z good");
	}

	@Test
	void anEmptyFileHasTheMinimalLayout() {
		assertThat(write(new SrsFile())).isEqualTo("""
				{
				  "schemaVersion": 1,
				  "config": {},
				  "cards": {}
				}
				""");
	}

	@Test
	void reviewsAreSortedAndDeduplicatedByTime() {
		SrsFile file = parse("""
				{"cards": {"x": {"reviews": ["2026-10-21T09:00:00Z easy", "2026-10-19T09:00:00.000Z hard",
				  "2026-10-21T09:00:00.000Z again", "not a review", "2026-10-22T09:00:00.000Z maybe", 7]}}}
				""");
		assertThat(file.cards.get("x").toDto().reviews()).containsExactly("2026-10-19T09:00:00.000Z hard",
				"2026-10-21T09:00:00.000Z easy");
	}

	@Test
	void unreadableRecordsAreSkippedAndUnreadableFilesAreEmpty() {
		SrsFile file = parse("""
				{"cards": {"bad id!": {"reviews": []}, "ok": {"reviews": []}, "list": [1]}}
				""");
		assertThat(file.cards).containsOnlyKeys("ok");
		assertThat(parse("not json").cards).isEmpty();
		assertThat(parse("[1, 2]").cards).isEmpty();
	}

	@Test
	void aStateThatDoesNotCoverTheReviewsIsDropped() {
		SrsFile file = parse(SAMPLE.replace("\"n\":2", "\"n\":1"));
		assertThat(file.cards.get("c1abc").state).isNull();
		SrsFile other = parse(SAMPLE.replace("\"lastReview\":\"2026-10-21T09:00:00.000Z\"",
				"\"lastReview\":\"2026-10-20T09:00:00.000Z\""));
		assertThat(other.cards.get("c1abc").state).isNull();
		SrsFile odd = parse(SAMPLE.replace("\"stability\":3.1262", "\"stability\":-1"));
		assertThat(odd.cards.get("c1abc").state).isNull();
	}

	@Test
	void matchesComparesTheCountAndTheLastReview() {
		SrsFile.Card card = new SrsFile.Card();
		Instant first = Instant.parse("2026-10-19T08:00:00.000Z");
		card.reviews.put(first, new ReviewEntry(first, "good", null));
		FlashcardCardState state = new FlashcardCardState(Instant.parse("2026-10-22T08:00:00Z"), 2.3, 5, 3, 0, 1, 0,
				FlashcardPhase.REVIEW, first, 1);
		assertThat(card.matches(state)).isTrue();
		Instant second = Instant.parse("2026-10-18T08:00:00.000Z");
		card.reviews.put(second, new ReviewEntry(second, "again", null));
		assertThat(card.matches(state)).isFalse();
	}

	@Test
	void theConfigFillsDefaultsAndIgnoresInvalidStoredValues() {
		FlashcardConfig config = parse(SAMPLE).resolvedConfig();
		assertThat(config.tags()).containsExactly("flashcards", "srs");
		assertThat(config.newPerDay()).isEqualTo(10);
		assertThat(config.reviewsPerDay()).isEqualTo(FlashcardConfig.DEFAULTS.reviewsPerDay());
		assertThat(config.learningSteps()).containsExactly("1m", "10m");
		FlashcardConfig broken = parse("""
				{"config": {"newPerDay": -3, "retention": 2, "tags": [], "learningSteps": ["soon"]}}
				""").resolvedConfig();
		assertThat(broken).isEqualTo(FlashcardConfig.DEFAULTS);
	}

	@Test
	void updatesAreValidatedFieldByFieldAndNullResets() {
		ObjectNode update = MAPPER.createObjectNode();
		update.put("newPerDay", 100000);
		update.put("retention", 0.5);
		update.putArray("tags").add("has space");
		update.putArray("learningSteps").add("1m").add("1y");
		update.put("fuzz", "yes");
		update.put("unknown", 1);
		List<FieldError> errors = SrsFile.validateUpdate(update);
		assertThat(errors).extracting(FieldError::field)
			.containsExactlyInAnyOrder("config.newPerDay", "config.retention", "config.tags", "config.learningSteps",
					"config.fuzz");

		SrsFile file = parse(SAMPLE);
		ObjectNode valid = MAPPER.createObjectNode();
		valid.putNull("newPerDay");
		valid.put("retention", 0.85);
		valid.putArray("tags").add("#cards");
		valid.put("unknown", 1);
		assertThat(SrsFile.validateUpdate(valid)).isEmpty();
		file.applyUpdate(valid);
		FlashcardConfig config = file.resolvedConfig();
		assertThat(config.newPerDay()).isEqualTo(20);
		assertThat(config.retention()).isEqualTo(0.85);
		assertThat(config.tags()).containsExactly("cards");
		assertThat(file.config).containsKey("someday").doesNotContainKey("unknown");
	}

	@Test
	void reviewEntriesRoundTrip() {
		ReviewEntry entry = ReviewEntry.parse("2026-10-21T09:00:00.123456Z hard 1200");
		assertThat(entry).isNotNull();
		assertThat(entry.format()).isEqualTo("2026-10-21T09:00:00.123Z hard 1200");
		assertThat(ReviewEntry.parse("2026-10-21T09:00:00Z reset").format()).isEqualTo("2026-10-21T09:00:00.000Z reset");
		assertThat(ReviewEntry.parse("2026-10-21T09:00:00Z good -1")).isNull();
		assertThat(ReviewEntry.parse("2026-10-21 good")).isNull();
		assertThat(ReviewEntry.parse("2026-10-21T09:00:00Z")).isNull();
	}

	@Test
	void cardMarkersAreFoundCheaply() {
		assertThat(FlashcardService.hasCardMarker("Q::A")).isTrue();
		assertThat(FlashcardService.hasCardMarker("a ==b== c")).isTrue();
		assertThat(FlashcardService.hasCardMarker("Question\n ? \nAnswer")).isTrue();
		assertThat(FlashcardService.hasCardMarker("Is this a question?\nNo.")).isFalse();
	}

}
