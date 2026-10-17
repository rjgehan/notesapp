package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.settings.LinkFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

class LinkTextGeneratorTest {

	private final VaultIndex index = IndexFixtures.index(IndexFixtures.API_VAULT);

	/** API.md §15.3 vectors. */
	@ParameterizedTest(name = "{index}: {0} from {1}, {2} {3}")
	@CsvSource(delimiter = '|', value = {
			"Projects/Alpha/notes.md | Welcome.md              | SHORTEST | WIKI     | notes",
			"Projects/Plan.md        | Welcome.md              | SHORTEST | WIKI     | Projects/Plan",
			"Plan.md                 | Daily/2026-10-16.md     | SHORTEST | WIKI     | Plan",
			"Archive/Spec.md         | Welcome.md              | SHORTEST | WIKI     | Archive/Spec",
			"Projects/Alpha/Spec.md  | Projects/Alpha/notes.md | RELATIVE | WIKI     | ./Spec",
			"Plan.md                 | Projects/Alpha/Spec.md  | RELATIVE | WIKI     | ../../Plan",
			"Attachments/pic.png     | Welcome.md              | SHORTEST | WIKI     | pic.png",
			"Ideas/Plan B.md         | Welcome.md              | SHORTEST | MARKDOWN | Plan%20B.md",
			"Projects/Plan.md        | Welcome.md              | ABSOLUTE | MARKDOWN | Projects/Plan.md",
			"v1.2 notes.md           | Welcome.md              | SHORTEST | WIKI     | v1.2 notes",
			"Daily/2026-10-16.md     | Welcome.md              | SHORTEST | WIKI     | 2026-10-16",
			"Ideas/Plan B.md         | Projects/Plan.md        | RELATIVE | MARKDOWN | ../Ideas/Plan%20B.md" })
	void apiVectors(String target, String source, LinkFormat format, LinkStyle style, String expected) {
		assertThat(this.index.linkText(target, source, format, style)).isEqualTo(expected);
	}

	@Test
	void encodeMdPathVectors() {
		assertThat(LinkTextGenerator.encodeMdPath("Notes (draft)/a b%.md")).isEqualTo("Notes%20%28draft%29/a%20b%25.md");
		assertThat(LinkTextGenerator.encodeMdPath("Café.md")).isEqualTo("Café.md");
		assertThat(LinkTextGenerator.encodeMdPath("<a>[b]#c^d|e\u0001")).isEqualTo("%3Ca%3E%5Bb%5D%23c%5Ed%7Ce%01");
	}

	@Test
	void relativeLinksAlwaysCarryADotPrefix() {
		assertThat(LinkTextGenerator.relative("", "Plan")).isEqualTo("./Plan");
		assertThat(LinkTextGenerator.relative("a", "a/b/c")).isEqualTo("./b/c");
		assertThat(LinkTextGenerator.relative("a/b", "c")).isEqualTo("../../c");
		assertThat(LinkTextGenerator.relative("a/b", "a/c")).isEqualTo("../c");
	}

	/** On a random 300-file vault, every generated link resolves back to its target, in every format and style. */
	@Test
	void generatedLinksRoundTrip() {
		Random random = new Random(20261016);
		String[] folders = { "A", "B", "a b", "Notes", "Projects", "Café" };
		String[] names = { "Plan", "plan", "Spec", "notes", "x y", "v1.2 notes", "Café", "Old", "Daily 2026" };
		String[] extensions = { ".md", ".md", ".md", ".png" };
		Set<String> paths = new LinkedHashSet<>();
		while (paths.size() < 300) {
			int depth = random.nextInt(4);
			StringBuilder path = new StringBuilder();
			for (int i = 0; i < depth; i++) {
				path.append(folders[random.nextInt(folders.length)]).append('/');
			}
			path.append(names[random.nextInt(names.length)]);
			if (random.nextInt(3) == 0) {
				path.append(' ').append(random.nextInt(20));
			}
			path.append(extensions[random.nextInt(extensions.length)]);
			paths.add(path.toString());
		}
		VaultIndex vault = IndexFixtures.index(new ArrayList<>(paths));
		List<String> all = new ArrayList<>(paths);
		for (int i = 0; i < 2000; i++) {
			String target = all.get(random.nextInt(all.size()));
			String source = all.get(random.nextInt(all.size()));
			for (LinkFormat format : LinkFormat.values()) {
				String wiki = vault.linkText(target, source, format, LinkStyle.WIKI);
				assertThat(vault.resolveLink(wiki, source)).as("%s from %s (%s wiki: %s)", target, source, format, wiki)
					.isEqualTo(target);
				String markdown = vault.linkText(target, source, format, LinkStyle.MARKDOWN);
				assertThat(vault.resolveLink(Syntax.percentDecode(markdown), source))
					.as("%s from %s (%s markdown: %s)", target, source, format, markdown)
					.isEqualTo(target);
			}
		}
	}

}
