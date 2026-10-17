package com.rjgehan.notes.index;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MentionFinderTest {

	private static List<MentionFinder.Found> find(String text, String... names) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		return MentionFinder.find(text, parse, MentionFinder.usableNames(List.of(names)));
	}

	private static List<String> matched(String text, String... names) {
		return find(text, names).stream().map(MentionFinder.Found::matched).toList();
	}

	@Test
	void wholeWordsMatchIgnoringCase() {
		assertThat(matched("The plan, a PLAN and planning plans. Plan!", "Plan")).containsExactly("plan", "PLAN",
				"Plan");
	}

	@Test
	void offsetsAndLinesAreAbsolute() {
		String text = "first line\nsee Roadmap here\n";
		MentionFinder.Found found = find(text, "Roadmap").get(0);
		assertThat(found.line()).isEqualTo(1);
		assertThat(text.substring(found.from(), found.to())).isEqualTo("Roadmap");
	}

	@Test
	void aliasesAreMatchedAndLongerNamesWin() {
		assertThat(matched("Plan B is better than plan", "Plan", "Plan B")).containsExactly("Plan B", "plan");
	}

	@Test
	void linksCodeFrontmatterTagsAndUrlsAreSkipped() {
		String text = """
				---
				title: Plan
				---
				[[Plan]] and [about the Plan](Plan.md) and `Plan` and #Plan
				https://example.com/Plan www.example.com/plan
				```
				Plan
				```
				%% Plan %% <!-- Plan -->
				a real Plan
				""";
		List<MentionFinder.Found> found = find(text, "Plan");
		assertThat(found).singleElement().satisfies((f) -> assertThat(f.line()).isEqualTo(9));
	}

	@Test
	void theTextOfExternalLinksIsSkipped() {
		String text = "Read [Gardening tips](https://example.com/garden) and ![Gardening](https://example.com/g.png)"
				+ " today. Also Gardening here.\n";
		List<MentionFinder.Found> found = find(text, "Gardening");
		assertThat(found).singleElement()
			.satisfies((f) -> assertThat(f.from()).isEqualTo(text.indexOf("Also Gardening") + "Also ".length()));
	}

	@Test
	void namesShorterThanThreeCharactersAreIgnored() {
		assertThat(MentionFinder.usableNames(List.of("AI", "  ", "Go", "Rust"))).containsExactly("Rust");
		assertThat(matched("AI and go", "AI", "Go")).isEmpty();
	}

	@Test
	void unicodeWordBoundariesHold() {
		assertThat(matched("Café and Cafés and café", "Café")).containsExactly("Café", "café");
		assertThat(matched("snake_plan and plan", "plan")).containsExactly("plan");
	}

}
