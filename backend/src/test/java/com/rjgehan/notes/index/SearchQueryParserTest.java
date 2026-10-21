package com.rjgehan.notes.index;

import java.util.List;

import com.rjgehan.notes.index.SearchQuery.And;
import com.rjgehan.notes.index.SearchQuery.Kind;
import com.rjgehan.notes.index.SearchQuery.Leaf;
import com.rjgehan.notes.index.SearchQuery.Node;
import com.rjgehan.notes.index.SearchQuery.Not;
import com.rjgehan.notes.index.SearchQuery.Or;
import com.rjgehan.notes.index.SearchQuery.Scope;
import com.rjgehan.notes.index.SearchQuery.Scoped;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SearchQueryParserTest {

	private static Node parse(String query) {
		return SearchQueryParser.parse(query).root();
	}

	private static Leaf word(String value) {
		return new Leaf(Kind.WORD, value, false, false);
	}

	private static Leaf lastWord(String value) {
		return new Leaf(Kind.WORD, value, false, true);
	}

	private static Leaf leaf(Kind kind, String value) {
		return new Leaf(kind, value, false, false);
	}

	private static Leaf regex(Kind kind, String value) {
		return new Leaf(kind, value, true, false);
	}

	private static And and(Node... children) {
		return new And(List.of(children));
	}

	private static Or or(Node... children) {
		return new Or(List.of(children));
	}

	@Test
	void theExampleFromTheContract() {
		assertThat(parse("\"weekly review\" tag:#work -draft")).isEqualTo(and(leaf(Kind.PHRASE, "weekly review"),
				leaf(Kind.TAG, "#work"), new Not(lastWord("draft"))));
	}

	@Test
	void filtersAreCaseInsensitiveAndTakeWordsOrPhrases() {
		assertThat(parse("PATH:Daily File:\"plan b\" -tag:\"project/alpha\"")).isEqualTo(and(leaf(Kind.PATH, "Daily"),
				leaf(Kind.FILE, "plan b"), new Not(leaf(Kind.TAG, "project/alpha"))));
	}

	@Test
	void negationAppliesToPhrasesToo() {
		assertThat(parse("-\"old idea\" new")).isEqualTo(and(new Not(leaf(Kind.PHRASE, "old idea")), lastWord("new")));
	}

	@Test
	void anUnterminatedPhraseRunsToTheEnd() {
		assertThat(parse("a \"b c")).isEqualTo(and(word("a"), leaf(Kind.PHRASE, "b c")));
	}

	@Test
	void aKeywordWithoutAValueIsAWordAndALoneDashIsAWord() {
		assertThat(parse("tag: -")).isEqualTo(and(word("tag:"), lastWord("-")));
	}

	@Test
	void wordsEndAtAQuote() {
		assertThat(parse("ab\"cd\"")).isEqualTo(and(word("ab"), leaf(Kind.PHRASE, "cd")));
	}

	@Test
	void blankQueriesAndEmptyPhrasesHaveNoClauses() {
		assertThat(parse("   ")).isNull();
		assertThat(parse("\"\"")).isNull();
		assertThat(parse("()")).isNull();
		assertThat(SearchQueryParser.parse("").matchesNothing()).isTrue();
		assertThat(SearchQueryParser.parse("-a -b").matchesNothing()).isTrue();
		assertThat(SearchQueryParser.parse("-a b").matchesNothing()).isFalse();
		assertThat(SearchQueryParser.parse("-(a OR b)").matchesNothing()).isTrue();
	}

	@Test
	void orBindsLooserThanAnd() {
		assertThat(parse("a b OR c")).isEqualTo(or(and(word("a"), word("b")), lastWord("c")));
		assertThat(parse("a OR b c")).isEqualTo(or(word("a"), and(word("b"), lastWord("c"))));
		assertThat(parse("a OR b OR c")).isEqualTo(or(word("a"), word("b"), lastWord("c")));
	}

	@Test
	void onlyUpperCaseOrIsAnOperator() {
		assertThat(parse("cats or dogs")).isEqualTo(and(word("cats"), word("or"), lastWord("dogs")));
		assertThat(parse("ORACLE")).isEqualTo(lastWord("ORACLE"));
	}

	@Test
	void leadingTrailingAndDoubledOrAreDropped() {
		assertThat(parse("OR a")).isEqualTo(lastWord("a"));
		assertThat(parse("a OR")).isEqualTo(word("a"));
		assertThat(parse("a OR OR b")).isEqualTo(or(word("a"), lastWord("b")));
	}

	@Test
	void parenthesesGroup() {
		assertThat(parse("(a OR b) c")).isEqualTo(and(or(word("a"), word("b")), lastWord("c")));
		assertThat(parse("-(draft OR wip) plan")).isEqualTo(and(new Not(or(word("draft"), word("wip"))),
				lastWord("plan")));
		assertThat(parse("x (a (b OR c))")).isEqualTo(and(word("x"), and(word("a"), or(word("b"), lastWord("c")))));
	}

	@Test
	void unbalancedParenthesesNeverFail() {
		assertThat(parse("(a OR b")).isEqualTo(or(word("a"), lastWord("b")));
		assertThat(parse("a) b")).isEqualTo(and(word("a)"), lastWord("b")));
		assertThat(parse(") a")).isEqualTo(lastWord("a"));
		assertThat(parse("((a")).isEqualTo(lastWord("a"));
	}

	@Test
	void theLastWordIsMarkedEvenBeforeClosingParentheses() {
		assertThat(parse("(a OR rev)")).isEqualTo(or(word("a"), lastWord("rev")));
		assertThat(parse("a \"b\"")).isEqualTo(and(word("a"), leaf(Kind.PHRASE, "b")));
	}

	@Test
	void regularExpressions() {
		assertThat(parse("/colou?r/")).isEqualTo(regex(Kind.REGEX, "colou?r"));
		assertThat(parse("/a\\/b/ x")).isEqualTo(and(regex(Kind.REGEX, "a\\/b"), lastWord("x")));
		assertThat(parse("file:/^2026-\\d+/ path:/^Daily/")).isEqualTo(and(regex(Kind.FILE, "^2026-\\d+"),
				regex(Kind.PATH, "^Daily")));
		assertThat(parse("(/x+/)")).isEqualTo(regex(Kind.REGEX, "x+"));
		assertThat(parse("/a b/")).isEqualTo(regex(Kind.REGEX, "a b"));
	}

	@Test
	void slashesThatDoNotCloseARegexAreWords() {
		assertThat(parse("/usr/bin")).isEqualTo(lastWord("/usr/bin"));
		assertThat(parse("/unterminated")).isEqualTo(lastWord("/unterminated"));
		assertThat(parse("//")).isEqualTo(lastWord("//"));
		assertThat(parse("a/b/")).isEqualTo(lastWord("a/b/"));
	}

	@Test
	void lineAndSectionScopes() {
		assertThat(parse("line:(mix flour)")).isEqualTo(new Scoped(Scope.LINE, and(word("mix"), lastWord("flour"))));
		assertThat(parse("section:\"open loops\" -line:x")).isEqualTo(and(
				new Scoped(Scope.SECTION, leaf(Kind.PHRASE, "open loops")), new Not(new Scoped(Scope.LINE,
						lastWord("x")))));
		assertThat(parse("LINE:/^- \\[ \\]/")).isEqualTo(new Scoped(Scope.LINE, regex(Kind.REGEX, "^- \\[ \\]")));
		assertThat(parse("line: x")).isEqualTo(and(word("line:"), lastWord("x")));
	}

	@Test
	void leavesAreListedInQueryOrder() {
		assertThat(SearchQueryParser.parse("a (b OR -c) line:d").leaves()).extracting(Leaf::value)
			.containsExactly("a", "b", "c", "d");
		assertThat(SearchQueryParser.parse("a /b/").readsText()).isTrue();
		assertThat(SearchQueryParser.parse("a section:b").readsText()).isTrue();
		assertThat(SearchQueryParser.parse("a \"b\" tag:c").readsText()).isFalse();
	}

}
