package com.rjgehan.notes.index;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TokenizerTest {

	private static List<String> terms(String text) {
		return Tokenizer.tokenize(text).stream().map(Tokenizer.Token::term).toList();
	}

	@Test
	void wordsAreRunsOfLettersAndNumbers() {
		assertThat(terms("Hello, World! v2 e-mail 2026-10-16")).containsExactly("hello", "world", "v2", "e", "mail",
				"2026", "10", "16");
	}

	@Test
	void caseAccentsAndWidthAreFolded() {
		assertThat(terms("Café NAÏVE Ｗｉｄｅ ﬁle Straße")).containsExactly("cafe", "naive", "wide", "file", "straße");
		assertThat(Tokenizer.normalize("Été")).isEqualTo("ete");
	}

	@Test
	void decomposedInputStaysOneToken() {
		List<Tokenizer.Token> tokens = Tokenizer.tokenize("café au lait");
		assertThat(tokens.get(0)).isEqualTo(new Tokenizer.Token("cafe", 0, 5));
		assertThat(tokens).hasSize(3);
	}

	@Test
	void eachHanKanaCodePointIsItsOwnToken() {
		assertThat(terms("東京タワーへ行く")).containsExactly("東", "京", "タ", "ワ", "ー", "へ", "行", "く");
		assertThat(terms("Rust言語")).containsExactly("rust", "言", "語");
	}

	@Test
	void offsetsPointAtTheOriginalText() {
		String text = "😀 Ｃａｆé, then 𝐁old";
		List<Tokenizer.Token> tokens = Tokenizer.tokenize(text);
		assertThat(tokens).extracting(Tokenizer.Token::term).containsExactly("cafe", "then", "bold");
		Tokenizer.Token cafe = tokens.get(0);
		assertThat(text.substring(cafe.from(), cafe.to())).isEqualTo("Ｃａｆé");
		Tokenizer.Token bold = tokens.get(2);
		assertThat(text.substring(bold.from(), bold.to())).isEqualTo("𝐁old");
	}

	@Test
	void aRangeCanBeTokenizedInPlace() {
		String text = "skip this line\nkeep these words";
		int start = text.indexOf('\n') + 1;
		List<Tokenizer.Token> tokens = Tokenizer.tokenize(text, start, text.length());
		assertThat(tokens).extracting(Tokenizer.Token::term).containsExactly("keep", "these", "words");
		assertThat(tokens.get(0).from()).isEqualTo(start);
	}

	@Test
	void punctuationOnlyTextHasNoTokens() {
		assertThat(terms("--- !!! ... #")).isEmpty();
	}

}
