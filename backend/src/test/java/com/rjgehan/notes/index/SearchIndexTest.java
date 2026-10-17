package com.rjgehan.notes.index;

import java.time.Instant;
import java.util.List;
import java.util.function.Predicate;

import com.rjgehan.notes.api.dto.SearchMatch;
import com.rjgehan.notes.api.dto.TextRange;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.TextCodec;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Full-text search through the index: matching, ranking, filters, snippets and index maintenance. */
class SearchIndexTest {

	private final VaultIndex index = new VaultIndex();

	private void note(String path, String text, int minute) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		byte[] bytes = TextCodec.encode(text, false);
		FileRecord record = new FileRecord(path, IndexFixtures.KINDS.kindOf(path), bytes.length,
				Instant.parse("2026-10-16T12:00:00Z").plusSeconds(60L * minute), Hashing.blobId(bytes),
				parse.aliases());
		this.index.put(new IndexedFile(record, path, text, parse));
	}

	private List<String> search(String query) {
		return search(query, true, (path) -> false, false);
	}

	private List<String> search(String query, boolean prefix, Predicate<String> excluded, boolean byMtime) {
		return this.index.search(SearchQueryParser.parse(query), prefix, excluded, byMtime)
			.hits()
			.stream()
			.map((hit) -> hit.note().path())
			.toList();
	}

	private VaultIndex.SearchHit hit(String query, String path) {
		return this.index.search(SearchQueryParser.parse(query), true, (p) -> false, false)
			.hits()
			.stream()
			.filter((hit) -> hit.note().path().equals(path))
			.findFirst()
			.orElseThrow();
	}

	@Test
	void theTitleOutranksTheBody() {
		note("Notes/Other.md", "This mentions the review once.\n", 1);
		note("Work/Review.md", "Nothing here.\n", 0);
		note("Notes/Unrelated.md", "Nothing.\n", 2);
		assertThat(search("review")).containsExactly("Work/Review.md", "Notes/Other.md");
		assertThat(hit("review", "Work/Review.md").score()).isGreaterThan(hit("review", "Notes/Other.md").score());
	}

	@Test
	void allClausesMustMatch() {
		note("a.md", "apple banana\n", 0);
		note("b.md", "apple cherry\n", 1);
		assertThat(search("apple banana")).containsExactly("a.md");
		assertThat(search("apple -banana")).containsExactly("b.md");
		assertThat(search("apple")).containsExactlyInAnyOrder("a.md", "b.md");
	}

	@Test
	void theLastBareWordMatchesAsAPrefix() {
		note("a.md", "The weekly review covers open loops.\n", 0);
		assertThat(search("weekly revi")).containsExactly("a.md");
		assertThat(search("weekly revi", false, (p) -> false, false)).isEmpty();
		assertThat(search("revi weekly")).isEmpty();
		assertThat(search("weekly r")).isEmpty();
		assertThat(search("weekly -revi")).containsExactly("a.md");
	}

	@Test
	void phrasesNeedConsecutiveTokens() {
		note("yes.md", "so the Weekly  Review covers it\n", 0);
		note("no.md", "weekly notes; review later\n", 1);
		assertThat(search("\"weekly review\"")).containsExactly("yes.md");
		assertThat(search("-\"weekly review\" weekly")).containsExactly("no.md");
	}

	@Test
	void phrasesStayWithinOneFieldAndFollowUpdatesAndMoves() {
		note("Weekly plan.md", "# Review notes\nThe review of the plan. Weekly\nreview\n", 0);
		note("other.md", "plan review weekly notes\n", 1);
		assertThat(search("\"weekly plan\"")).containsExactly("Weekly plan.md");
		assertThat(search("\"review notes\"")).containsExactly("Weekly plan.md");
		assertThat(search("\"plan review\"")).containsExactly("other.md");
		assertThat(search("\"plan of\"")).isEmpty();
		assertThat(search("\"weekly review\"")).containsExactly("Weekly plan.md");
		assertThat(search("\"weekly rev")).isEmpty();
		this.index.move("Weekly plan.md", "Monthly plan.md", "Monthly plan.md");
		assertThat(search("\"weekly plan\"")).isEmpty();
		assertThat(search("\"monthly plan\"")).containsExactly("Monthly plan.md");
		note("other.md", "notes weekly plan\n", 2);
		assertThat(search("\"weekly plan\"")).containsExactly("other.md");
		assertThat(search("\"plan review\"")).isEmpty();
	}

	@Test
	void aWordWithSeveralTokensActsAsAPhrase() {
		note("yes.md", "send an E-Mail today\n", 0);
		note("no.md", "e then mail\n", 1);
		assertThat(search("e-mail")).containsExactly("yes.md");
		assertThat(search("e-ma")).containsExactly("yes.md");
	}

	@Test
	void matchingIgnoresCaseAccentsAndWidth() {
		note("cafe.md", "Meet at the CAFÉ\n", 0);
		assertThat(search("cafe")).containsExactly("cafe.md");
		assertThat(search("Ｃａｆｅ")).containsExactly("cafe.md");
	}

	@Test
	void cjkTextIsSearchable() {
		note("tokyo.md", "東京タワーへ行く\n", 0);
		assertThat(search("東京")).containsExactly("tokyo.md");
		assertThat(search("\"京タ\"")).containsExactly("tokyo.md");
		assertThat(search("大阪")).isEmpty();
	}

	@Test
	void aliasesHeadingsAndTagsAreSearchedToo() {
		note("a.md", "---\naliases: [Roadmap]\ntags: [planning]\n---\n# Quarterly goals\nbody\n", 0);
		assertThat(search("roadmap")).containsExactly("a.md");
		assertThat(search("quarterly")).containsExactly("a.md");
		assertThat(search("planning")).containsExactly("a.md");
	}

	@Test
	void tagFiltersMatchNestedTags() {
		note("alpha.md", "#project/alpha work\n", 0);
		note("project.md", "#project\n", 1);
		note("other.md", "#projects\n", 2);
		assertThat(search("tag:project")).containsExactlyInAnyOrder("alpha.md", "project.md");
		assertThat(search("tag:#Project/Alpha")).containsExactly("alpha.md");
		assertThat(search("-tag:project tag:projects")).containsExactly("other.md");
		assertThat(hit("tag:project", "alpha.md").score()).isZero();
	}

	@Test
	void pathAndFileFiltersAreCaseInsensitiveSubstrings() {
		note("Daily/2026-10-16.md", "x\n", 0);
		note("Projects/Daily standup.md", "x\n", 1);
		assertThat(search("path:daily/")).containsExactly("Daily/2026-10-16.md");
		assertThat(search("file:STANDUP")).containsExactly("Projects/Daily standup.md");
		assertThat(search("path:daily -file:standup")).containsExactly("Daily/2026-10-16.md");
	}

	@Test
	void emptyAndNegativeOnlyQueriesMatchNothing() {
		note("a.md", "anything\n", 0);
		assertThat(search("")).isEmpty();
		assertThat(search("-anything")).isEmpty();
		assertThat(search("!!!")).isEmpty();
	}

	@Test
	void excludedPathsAreNeverReturned() {
		note("Archive/old.md", "secret plan\n", 0);
		note("Notes/new.md", "secret plan\n", 1);
		assertThat(search("secret", true, (path) -> PathNames.lower(path).startsWith("archive"), false))
			.containsExactly("Notes/new.md");
	}

	@Test
	void mtimeSortListsTheNewestFirst() {
		note("old.md", "topic topic topic\n", 0);
		note("new.md", "topic\n", 5);
		assertThat(search("topic", true, (p) -> false, true)).containsExactly("new.md", "old.md");
	}

	@Test
	void updatesAndRemovalsReplaceTheTerms() {
		note("a.md", "first version\n", 0);
		note("a.md", "second version\n", 1);
		assertThat(search("first")).isEmpty();
		assertThat(search("second")).containsExactly("a.md");
		this.index.removeFile("a.md");
		assertThat(search("second")).isEmpty();
	}

	@Test
	void movesKeepTheBodyAndRetitleTheNote() {
		note("Old name.md", "body words\n", 0);
		this.index.move("Old name.md", "Archive/New title.md", "Archive/New title.md");
		assertThat(search("body")).containsExactly("Archive/New title.md");
		assertThat(search("title")).containsExactly("Archive/New title.md");
		assertThat(search("old")).isEmpty();
		note("Folder/Note.md", "inside\n", 1);
		this.index.move("Folder", "Moved", "Moved");
		assertThat(search("inside")).containsExactly("Moved/Note.md");
	}

	@Test
	void snippetRangesPointAtTheOriginalText() {
		String text = "---\ntitle: café\n---\n# Heading\nWe met at the Café. Later, another café.\nno match\n";
		note("Visit Café.md", text, 0);
		VaultIndex.SearchOutcome outcome = this.index.search(SearchQueryParser.parse("cafe"), true, (p) -> false,
				false);
		NoteRecord note = outcome.hits().get(0).note();
		SnippetBuilder.Snippets snippets = SnippetBuilder.build("Visit Café", note.text(), note.parse(),
				outcome.patterns());
		assertThat(snippets.titleRanges()).containsExactly(new TextRange(6, 10));
		assertThat(snippets.matches()).singleElement().satisfies((match) -> {
			assertThat(match.line()).isEqualTo(4);
			assertThat(match.text()).isEqualTo("We met at the Café. Later, another café.");
			assertThat(match.ranges()).containsExactly(new TextRange(14, 18), new TextRange(35, 39));
		});
		assertThat(snippets.moreMatches()).isZero();
	}

	@Test
	void snippetsShowThreeLinesClippedToTwoHundredCharacters() {
		String filler = "x".repeat(300);
		String text = "match one\n" + filler + " match two " + filler + "\nmatch three\nmatch four\nmatch five\n";
		note("long.md", text, 0);
		VaultIndex.SearchOutcome outcome = this.index.search(SearchQueryParser.parse("\"match two\""), false,
				(p) -> false, false);
		SnippetBuilder.Snippets phrase = SnippetBuilder.build("long", text, outcome.hits().get(0).note().parse(),
				outcome.patterns());
		SearchMatch clipped = phrase.matches().get(0);
		assertThat(clipped.text()).hasSizeLessThanOrEqualTo(SnippetBuilder.MATCH_WIDTH).startsWith("…").endsWith("…");
		TextRange range = clipped.ranges().get(0);
		assertThat(clipped.text().substring(range.from(), range.to())).isEqualTo("match two");
		outcome = this.index.search(SearchQueryParser.parse("match"), false, (p) -> false, false);
		SnippetBuilder.Snippets all = SnippetBuilder.build("long", text, outcome.hits().get(0).note().parse(),
				outcome.patterns());
		assertThat(all.matches()).extracting(SearchMatch::line).containsExactly(0, 1, 2);
		assertThat(all.moreMatches()).isEqualTo(2);
	}

}
