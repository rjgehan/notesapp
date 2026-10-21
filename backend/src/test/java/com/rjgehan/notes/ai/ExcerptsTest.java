package com.rjgehan.notes.ai;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ExcerptsTest {

	@Test
	void aNoteThatFitsIsSentWhole() {
		Excerpts.Excerpt excerpt = Excerpts.select("# Plan\n\nShort note.", List.of("plan"), 100);
		assertThat(excerpt.text()).isEqualTo("# Plan\n\nShort note.");
		assertThat(excerpt.truncated()).isFalse();
	}

	@Test
	void aLongNoteKeepsTheParagraphsWithTheTermsInDocumentOrder() {
		String text = "Intro about nothing much.\n\n" + "filler ".repeat(100) + "\n\nThe budget for the kitchen is 12k.\n\n"
				+ "more filler ".repeat(100) + "\n\nKitchen tiles arrive Monday.\n\nThe end.";
		Excerpts.Excerpt excerpt = Excerpts.select(text, List.of("kitchen", "budget"), 200);
		assertThat(excerpt.truncated()).isTrue();
		assertThat(excerpt.text()).contains("The budget for the kitchen is 12k.")
			.contains("Kitchen tiles arrive Monday.")
			.doesNotContain("filler");
		assertThat(excerpt.text().indexOf("budget")).isLessThan(excerpt.text().indexOf("tiles"));
		assertThat(excerpt.text()).startsWith(Excerpts.GAP).endsWith(Excerpts.GAP);
		assertThat(excerpt.text().length()).isLessThanOrEqualTo(200);
	}

	@Test
	void withoutMatchingTermsTheBeginningIsKept() {
		String text = "First line\nsecond line\n" + "x".repeat(500);
		Excerpts.Excerpt excerpt = Excerpts.select(text, List.of("absent"), 100);
		assertThat(excerpt.truncated()).isTrue();
		assertThat(excerpt.text()).startsWith("First line").endsWith(Excerpts.GAP);
		assertThat(excerpt.text().length()).isLessThanOrEqualTo(100);
	}

	@Test
	void aSingleHugeParagraphIsCutAroundItsFirstMatch() {
		String text = "a ".repeat(1000) + "needle " + "b ".repeat(1000);
		Excerpts.Excerpt excerpt = Excerpts.select(text, List.of("needle"), 120);
		assertThat(excerpt.text()).contains("needle");
		assertThat(excerpt.text().length()).isLessThanOrEqualTo(120);
	}

	@Test
	void theSameInputGivesTheSameExcerpt() {
		String text = ("Paragraph about apples.\n\n" + "noise ".repeat(50) + "\n\n").repeat(20);
		assertThat(Excerpts.select(text, List.of("apples"), 500))
			.isEqualTo(Excerpts.select(text, List.of("apples"), 500));
	}

	@Test
	void surrogatePairsAreNeverSplit() {
		String text = "😀".repeat(100);
		String head = Excerpts.head(text, 51);
		assertThat(Character.isHighSurrogate(head.charAt(head.length() - 1))).isFalse();
	}

}
