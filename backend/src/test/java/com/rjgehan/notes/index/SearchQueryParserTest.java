package com.rjgehan.notes.index;

import java.util.List;

import com.rjgehan.notes.index.SearchQuery.Clause;
import com.rjgehan.notes.index.SearchQuery.Kind;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SearchQueryParserTest {

	private static List<Clause> parse(String query) {
		return SearchQueryParser.parse(query).clauses();
	}

	@Test
	void theExampleFromTheContract() {
		assertThat(parse("\"weekly review\" tag:#work -draft")).containsExactly(
				new Clause(Kind.PHRASE, "weekly review", false), new Clause(Kind.TAG, "#work", false),
				new Clause(Kind.WORD, "draft", true));
	}

	@Test
	void filtersAreCaseInsensitiveAndTakeWordsOrPhrases() {
		assertThat(parse("PATH:Daily File:\"plan b\" -tag:\"project/alpha\"")).containsExactly(
				new Clause(Kind.PATH, "Daily", false), new Clause(Kind.FILE, "plan b", false),
				new Clause(Kind.TAG, "project/alpha", true));
	}

	@Test
	void negationAppliesToPhrasesToo() {
		assertThat(parse("-\"old idea\" new")).containsExactly(new Clause(Kind.PHRASE, "old idea", true),
				new Clause(Kind.WORD, "new", false));
	}

	@Test
	void anUnterminatedPhraseRunsToTheEnd() {
		assertThat(parse("a \"b c")).containsExactly(new Clause(Kind.WORD, "a", false),
				new Clause(Kind.PHRASE, "b c", false));
	}

	@Test
	void aKeywordWithoutAValueIsAWordAndALoneDashIsAWord() {
		assertThat(parse("tag: -")).containsExactly(new Clause(Kind.WORD, "tag:", false),
				new Clause(Kind.WORD, "-", false));
	}

	@Test
	void wordsEndAtAQuote() {
		assertThat(parse("ab\"cd\"")).containsExactly(new Clause(Kind.WORD, "ab", false),
				new Clause(Kind.PHRASE, "cd", false));
	}

	@Test
	void blankQueriesAndEmptyPhrasesHaveNoClauses() {
		assertThat(parse("   ")).isEmpty();
		assertThat(parse("\"\"")).isEmpty();
		assertThat(SearchQueryParser.parse("").matchesNothing()).isTrue();
		assertThat(SearchQueryParser.parse("-a -b").matchesNothing()).isTrue();
		assertThat(SearchQueryParser.parse("-a b").matchesNothing()).isFalse();
	}

}
