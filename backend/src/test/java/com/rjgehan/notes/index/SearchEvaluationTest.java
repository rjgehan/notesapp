package com.rjgehan.notes.index;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.SearchMatch;
import com.rjgehan.notes.api.dto.TextRange;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The query language of item 22: OR and groups, regular expressions, line and section scopes, typo tolerance. */
class SearchEvaluationTest {

	private final VaultIndex index = new VaultIndex();

	private void note(String path, String text, int minute) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		byte[] bytes = TextCodec.encode(text, false);
		FileRecord record = new FileRecord(path, IndexFixtures.KINDS.kindOf(path), bytes.length,
				Instant.parse("2026-10-16T12:00:00Z").plusSeconds(60L * minute), Hashing.blobId(bytes),
				parse.aliases());
		this.index.put(new IndexedFile(record, path, text, parse));
	}

	/** A PDF whose text was extracted, as {@link PdfTextIndexer} swaps it in. */
	private void pdf(String path, String text) {
		FileRecord record = new FileRecord(path, FileKind.PDF, 1000, Instant.parse("2026-10-16T12:00:00Z"), null,
				List.of());
		this.index.put(new IndexedFile(record, path, null, null));
		NoteParse parse = PdfTextIndexer.parseOf(text);
		String basename = path.substring(path.lastIndexOf('/') + 1).replace(".pdf", "");
		assertThat(this.index.putExtracted(record, text, parse, SearchIndex.Doc.of(basename, text, parse))).isTrue();
	}

	private VaultIndex.SearchOutcome outcome(String query, boolean fuzzy, Duration budget) {
		return this.index.search(SearchQueryParser.parse(query),
				new VaultIndex.SearchOptions(true, fuzzy, (path) -> false, false, budget));
	}

	private List<String> search(String query) {
		return outcome(query, false, Duration.ofSeconds(10)).hits().stream().map((hit) -> hit.note().path()).toList();
	}

	@Test
	void orMatchesEitherSide() {
		note("cats.md", "I like cats\n", 0);
		note("dogs.md", "I like dogs\n", 1);
		note("fish.md", "I like fish\n", 2);
		assertThat(search("cats OR dogs")).containsExactlyInAnyOrder("cats.md", "dogs.md");
		assertThat(search("like (cats OR dogs) -dogs")).containsExactly("cats.md");
		assertThat(search("cats OR dogs OR fish")).hasSize(3);
		assertThat(search("cats OR nothing")).containsExactly("cats.md");
	}

	@Test
	void negatedGroupsExcludeAndNegationsAloneMatchNothing() {
		note("a.md", "plan draft\n", 0);
		note("b.md", "plan wip\n", 1);
		note("c.md", "plan final\n", 2);
		assertThat(search("plan -(draft OR wip)")).containsExactly("c.md");
		assertThat(search("-draft OR final")).containsExactly("c.md");
		assertThat(search("(-draft -wip)")).isEmpty();
		assertThat(search("-(draft OR wip)")).isEmpty();
	}

	@Test
	void theLastWordIsAPrefixInsideAGroup() {
		note("a.md", "the weekly review\n", 0);
		note("b.md", "monthly report\n", 1);
		assertThat(search("(monthly OR revi)")).containsExactlyInAnyOrder("a.md", "b.md");
		assertThat(search("(revi OR monthly)")).containsExactly("b.md");
	}

	@Test
	void regularExpressionsMatchTheText() {
		note("color.md", "The colour of the sky\n", 0);
		note("other.md", "No match here\n", 1);
		note("Daily/2026-10-16.md", "x\n", 2);
		note("Daily/notes.md", "#project/alpha\n", 3);
		assertThat(search("/colou?r/")).containsExactly("color.md");
		assertThat(search("/COLOUR/")).containsExactly("color.md");
		assertThat(search("/(?-i)COLOUR/")).isEmpty();
		assertThat(search("/^No match/")).containsExactly("other.md");
		assertThat(search("file:/^\\d{4}-\\d{2}-\\d{2}\\.md$/")).containsExactly("Daily/2026-10-16.md");
		assertThat(search("path:/^daily\\//")).containsExactlyInAnyOrder("Daily/2026-10-16.md", "Daily/notes.md");
		assertThat(search("tag:/^project\\//")).containsExactly("Daily/notes.md");
		assertThat(search("sky -/colou?r/")).isEmpty();
	}

	@Test
	void anInvalidRegularExpressionIsReported() {
		note("a.md", "x\n", 0);
		assertThatThrownBy(() -> search("/a(b/")).isInstanceOf(SearchRegex.InvalidException.class)
			.hasMessageContaining("Invalid regular expression");
		assertThatThrownBy(() -> search("/" + "a".repeat(SearchRegex.MAX_LENGTH + 1) + "/"))
			.isInstanceOf(SearchRegex.InvalidException.class);
	}

	@Test
	void catastrophicBacktrackingRunsOutOfTime() {
		StringBuilder csv = new StringBuilder();
		for (int i = 1; i <= 30; i++) {
			csv.append(i).append(',');
		}
		note("a.md", csv + "\n", 0);
		long started = System.nanoTime();
		assertThatThrownBy(() -> outcome("/(.*?,){15}P/", false, Duration.ofMillis(200)))
			.isInstanceOf(SearchRegex.TimeoutException.class);
		assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
	}

	@Test
	void lineScopesNeedEverythingOnOneLine() {
		note("yes.md", "---\ntags: [x]\n---\nmix the flour and sugar\nbake\n", 0);
		note("no.md", "mix well\nflour later\n", 1);
		assertThat(search("line:(mix flour)")).containsExactly("yes.md");
		assertThat(search("mix flour")).containsExactlyInAnyOrder("yes.md", "no.md");
		assertThat(search("line:(mix -flour)")).containsExactly("no.md");
		assertThat(search("line:(flour OR bake) line:\"mix well\"")).containsExactly("no.md");
		assertThat(search("line:/^bake$/")).containsExactly("yes.md");
		assertThat(search("-line:(mix flour) mix")).containsExactly("no.md");
		assertThat(search("line:(tags x)")).isEmpty();
	}

	@Test
	void sectionScopesStopAtHeadings() {
		note("a.md", "# Groceries\nmilk\neggs\n# Errands\nbank\n", 0);
		assertThat(search("section:(milk eggs)")).containsExactly("a.md");
		assertThat(search("section:(milk bank)")).isEmpty();
		assertThat(search("section:(errands bank)")).containsExactly("a.md");
		assertThat(search("milk bank")).containsExactly("a.md");
	}

	@Test
	void scopesWorkOnLargeVaultsInParallel() {
		for (int i = 0; i < 300; i++) {
			note("n" + i + ".md", (i % 3 == 0) ? "alpha beta\n" : "alpha\nbeta\n", i);
		}
		assertThat(search("line:(alpha beta)")).hasSize(100);
		assertThat(search("line:/alpha beta/")).hasSize(100);
	}

	@Test
	void pdfTextIsSearchedWithPages() {
		pdf("Docs/Manual.pdf", "Getting started\nInstall the printer" + PdfText.PAGE_BREAK + "Troubleshooting\n"
				+ "Paper jam: open the tray");
		note("a.md", "printer notes\n", 0);
		VaultIndex.SearchOutcome outcome = outcome("paper jam", false, Duration.ofSeconds(5));
		assertThat(outcome.hits()).singleElement().satisfies((hit) -> {
			assertThat(hit.note().path()).isEqualTo("Docs/Manual.pdf");
			assertThat(hit.kind()).isEqualTo(FileKind.PDF);
		});
		VaultIndex.SearchHit hit = outcome.hits().get(0);
		SnippetBuilder.Snippets snippets = SnippetBuilder.build("Manual", hit.note().text(), hit.note().parse(),
				outcome.patterns(), outcome.regexes(), outcome.budget(), true);
		assertThat(snippets.matches()).singleElement().satisfies((match) -> {
			assertThat(match.page()).isEqualTo(2);
			assertThat(match.text()).isEqualTo("Paper jam: open the tray");
		});
		assertThat(search("printer")).containsExactlyInAnyOrder("Docs/Manual.pdf", "a.md");
		assertThat(search("file:manual")).containsExactly("Docs/Manual.pdf");
		assertThat(search("section:(install troubleshooting)")).isEmpty();
		assertThat(search("section:(paper troubleshooting)")).containsExactly("Docs/Manual.pdf");
		assertThat(search("tag:printer")).isEmpty();
	}

	@Test
	void pdfTextFollowsMovesAndIsDroppedWhenTheFileChanges() {
		pdf("Manual.pdf", "unique words");
		this.index.move("Manual.pdf", "Archive/Old manual.pdf", "Archive/Old manual.pdf");
		assertThat(search("unique")).containsExactly("Archive/Old manual.pdf");
		assertThat(search("old manual")).containsExactly("Archive/Old manual.pdf");
		FileRecord changed = new FileRecord("Archive/Old manual.pdf", FileKind.PDF, 2000,
				Instant.parse("2026-10-17T12:00:00Z"), null, List.of());
		this.index.put(new IndexedFile(changed, "Archive/Old manual.pdf", null, null));
		assertThat(search("unique")).isEmpty();
		assertThat(this.index.hasExtracted("Archive/Old manual.pdf")).isFalse();
		this.index.removeFile("Archive/Old manual.pdf");
		assertThat(search("manual")).isEmpty();
	}

	@Test
	void staleExtractedTextIsRefused() {
		FileRecord record = new FileRecord("a.pdf", FileKind.PDF, 10, Instant.EPOCH, null, List.of());
		this.index.put(new IndexedFile(record, "a.pdf", null, null));
		FileRecord older = new FileRecord("a.pdf", FileKind.PDF, 9, Instant.EPOCH, null, List.of());
		NoteParse parse = PdfTextIndexer.parseOf("text");
		assertThat(this.index.putExtracted(older, "text", parse, SearchIndex.Doc.of("a", "text", parse))).isFalse();
		assertThat(search("text")).isEmpty();
	}

	@Test
	void typosAreToleratedWhenAWordIsNotInTheIndex() {
		note("a.md", "We receive the parcel on Tuesday\n", 0);
		note("b.md", "The 2026 budget\n", 1);
		VaultIndex.SearchOutcome outcome = outcome("recieve", true, Duration.ofSeconds(5));
		assertThat(outcome.hits()).extracting((hit) -> hit.note().path()).containsExactly("a.md");
		assertThat(outcome.corrections()).singleElement().satisfies((correction) -> {
			assertThat(correction.term()).isEqualTo("recieve");
			assertThat(correction.replacements()).containsExactly("receive");
		});
		assertThat(outcome("tuseday parcel", true, Duration.ofSeconds(5)).hits()).hasSize(1);
		assertThat(outcome("\"recieve the\"", true, Duration.ofSeconds(5)).hits()).hasSize(1);
		// Short words and numbers are never corrected; known words are not either.
		assertThat(outcome("2025", true, Duration.ofSeconds(5)).hits()).isEmpty();
		assertThat(outcome("teh", true, Duration.ofSeconds(5)).hits()).isEmpty();
		assertThat(outcome("receive", true, Duration.ofSeconds(5)).corrections()).isEmpty();
		assertThat(outcome("recieve", false, Duration.ofSeconds(5)).hits()).isEmpty();
		// A negated word is not corrected.
		assertThat(outcome("parcel -recieve", true, Duration.ofSeconds(5)).hits()).hasSize(1);
	}

	@Test
	void correctedWordsAreHighlighted() {
		note("a.md", "We receive it\n", 0);
		VaultIndex.SearchOutcome outcome = outcome("recieve", true, Duration.ofSeconds(5));
		NoteRecord note = outcome.hits().get(0).note();
		SnippetBuilder.Snippets snippets = SnippetBuilder.build("a", note.text(), note.parse(), outcome.patterns());
		assertThat(snippets.matches()).extracting(SearchMatch::ranges)
			.containsExactly(List.of(new TextRange(3, 10)));
	}

	@Test
	void regularExpressionMatchesAreHighlighted() {
		note("a.md", "Call 555-1234 or 555-9876\nnothing\n", 0);
		VaultIndex.SearchOutcome outcome = outcome("/\\d{3}-\\d{4}/", false, Duration.ofSeconds(5));
		NoteRecord note = outcome.hits().get(0).note();
		SnippetBuilder.Snippets snippets = SnippetBuilder.build("a", note.text(), note.parse(), outcome.patterns(),
				outcome.regexes(), outcome.budget(), false);
		assertThat(snippets.matches()).singleElement().satisfies((match) -> {
			assertThat(match.page()).isNull();
			assertThat(match.ranges()).containsExactly(new TextRange(5, 13), new TextRange(17, 25));
		});
	}

}
