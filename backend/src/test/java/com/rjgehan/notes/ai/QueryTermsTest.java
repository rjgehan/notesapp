package com.rjgehan.notes.ai;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class QueryTermsTest {

	@Test
	void dropsCommonWordsAndKeepsTheRestNormalized() {
		assertThat(QueryTerms.of("What did I decide about the Kitchen budget in 2026?"))
			.containsExactly("decide", "kitchen", "budget", "2026");
	}

	@Test
	void stripsAccentsLikeTheIndex() {
		assertThat(QueryTerms.of("Café menu")).containsExactly("cafe", "menu");
	}

	@Test
	void keepsSingleHanCharactersButNotSingleLetters() {
		assertThat(QueryTerms.of("x 猫 y 7")).containsExactly("猫", "7");
	}

	@Test
	void aQuestionOfOnlyCommonWordsHasNoTerms() {
		assertThat(QueryTerms.of("What is this about?")).isEmpty();
	}

	@Test
	void describingPrefersTitleWordsAndFrequentWords() {
		assertThat(QueryTerms.describing("Garden plan", "tomatoes tomatoes tomatoes basil", 3))
			.containsExactly("garden", "plan", "tomatoes");
	}

}
