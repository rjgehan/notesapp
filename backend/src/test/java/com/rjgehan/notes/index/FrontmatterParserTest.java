package com.rjgehan.notes.index;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class FrontmatterParserTest {

	private static NoteParse scan(String text) {
		return MarkdownScanner.scan(text, false, false);
	}

	private static Map<String, Object> data(NoteParse parse) {
		assertThat(parse.frontmatter()).isNotNull();
		assertThat(parse.frontmatter().data()).isNotNull();
		return parse.frontmatter().data();
	}

	@Test
	void coreSchemaKeepsDatesAndYesAsStrings() {
		Map<String, Object> data = data(scan("---\ndate: 2026-10-16\nflag: yes\ncount: 3\nreal: true\n---\n"));
		assertThat(data.get("date")).isEqualTo("2026-10-16");
		assertThat(data.get("flag")).isEqualTo("yes");
		assertThat(data.get("count")).isEqualTo(3);
		assertThat(data.get("real")).isEqualTo(true);
	}

	@Test
	void duplicateKeysKeepTheLastValue() {
		assertThat(data(scan("---\na: 1\na: 2\n---\n")).get("a")).isEqualTo(2);
	}

	@Test
	void malformedYamlStillIndexesTheNote() {
		NoteParse parse = scan("---\nfoo: [unclosed\nbar: x\n---\nBody #tag [[Link]]\n");
		assertThat(parse.frontmatter()).isNotNull();
		assertThat(parse.frontmatter().data()).isNull();
		assertThat(parse.frontmatterError()).isNotBlank();
		assertThat(parse.distinctTags()).containsExactly("tag");
		assertThat(parse.links()).extracting(LinkOcc::target).containsExactly("Link");
	}

	@Test
	void tagsAsACommaAndSpaceSeparatedString() {
		NoteParse parse = scan("---\ntags: \"a, b c\"\n---\n");
		assertThat(parse.distinctTags()).containsExactly("a", "b", "c");
		assertThat(parse.tags()).allSatisfy((tag) -> {
			assertThat(tag.inFrontmatter()).isTrue();
			assertThat(tag.line()).isEqualTo(1);
		});
	}

	@Test
	void tagListsStripHashesAndDropInvalidTags() {
		NoteParse parse = scan("---\ntags:\n  - \"#project/alpha\"\n  - 1984\n  - has space\n  - ok/\ntag: single\n---\n");
		assertThat(parse.distinctTags()).containsExactly("project/alpha", "ok", "single");
	}

	@Test
	void aliasesFromBothKeys() {
		assertThat(scan("---\nalias: x\n---\n").aliases()).containsExactly("x");
		assertThat(scan("---\naliases: [Roadmap, \" Plan \", \"\"]\n---\n").aliases()).containsExactly("Roadmap", "Plan");
		assertThat(scan("---\naliases: Single\n---\n").aliases()).containsExactly("Single");
	}

	@Test
	void quotedWikilinksBecomeRewritableLinksWithFullFileOffsets() {
		String text = "---\nrelated: \"[[Link]]\"\nup: [\"[[A]]\", \"see [[B|b]]\"]\n---\nBody\n";
		NoteParse parse = scan(text);
		assertThat(parse.links()).extracting(LinkOcc::target).containsExactly("Link", "A", "B");
		LinkOcc link = parse.links().get(0);
		assertThat(link.inFrontmatter()).isTrue();
		assertThat(link.rewritable()).isTrue();
		assertThat(link.line()).isEqualTo(1);
		assertThat(link.from()).isEqualTo(text.indexOf("[[Link]]"));
		assertThat(text.substring(link.from(), link.to())).isEqualTo("[[Link]]");
		assertThat(text.substring(link.targetFrom(), link.targetTo())).isEqualTo("Link");
		LinkOcc withDisplay = parse.links().get(2);
		assertThat(withDisplay.display()).isEqualTo("b");
		assertThat(withDisplay.line()).isEqualTo(2);
		assertThat(withDisplay.rewritable()).isTrue();
	}

	@Test
	void frontmatterLinksKnowTheirYamlQuoting() {
		NoteParse parse = scan("---\nplain: see [[P]]\nsingle: '[[S]]'\ndouble: \"[[D]]\"\nblock: |\n  [[B]]\n---\n[[Body]]\n");
		assertThat(parse.links()).extracting(LinkOcc::target, LinkOcc::quoting)
			.containsExactly(org.assertj.core.groups.Tuple.tuple("P", LinkOcc.Quoting.PLAIN),
					org.assertj.core.groups.Tuple.tuple("S", LinkOcc.Quoting.SINGLE_QUOTED),
					org.assertj.core.groups.Tuple.tuple("D", LinkOcc.Quoting.DOUBLE_QUOTED),
					org.assertj.core.groups.Tuple.tuple("B", LinkOcc.Quoting.BLOCK),
					org.assertj.core.groups.Tuple.tuple("Body", LinkOcc.Quoting.BODY));
		assertThat(parse.links()).allSatisfy((link) -> assertThat(link.rewritable()).isTrue());
	}

	@Test
	void replacementsAreEncodedForTheirQuoting() {
		assertThat(LinkOcc.Quoting.SINGLE_QUOTED.encode("Bob's Target")).isEqualTo("Bob''s Target");
		assertThat(LinkOcc.Quoting.DOUBLE_QUOTED.encode("a\\b \"c\"")).isEqualTo("a\\\\b \\\"c\\\"");
		assertThat(LinkOcc.Quoting.PLAIN.encode("Bob's Target")).isEqualTo("Bob's Target");
		assertThat(LinkOcc.Quoting.PLAIN.encode("Meeting 10: notes")).isNull();
		assertThat(LinkOcc.Quoting.PLAIN.encode("a #b")).isNull();
		assertThat(LinkOcc.Quoting.BLOCK.encode("Bob's: #Target")).isEqualTo("Bob's: #Target");
		assertThat(LinkOcc.Quoting.BODY.encode("a: #b's")).isEqualTo("a: #b's");
	}

	@Test
	void escapedLinksCountAsBacklinksButAreNotRewritable() {
		String text = "---\nx: \"[[A\\u00e9]]\"\n---\n";
		NoteParse parse = scan(text);
		assertThat(parse.links()).hasSize(1);
		LinkOcc link = parse.links().get(0);
		assertThat(link.target()).isEqualTo("Aé");
		assertThat(link.rewritable()).isFalse();
		assertThat(link.inFrontmatter()).isTrue();
	}

	@Test
	void foldedScalarsSplitAcrossLinesAreNotRewritable() {
		String text = "---\nx: >\n  [[A\n  B]]\n---\n";
		NoteParse parse = scan(text);
		assertThat(parse.links()).extracting(LinkOcc::target).containsExactly("A B");
		assertThat(parse.links().get(0).rewritable()).isFalse();
	}

	@Test
	void unquotedBracketsAreYamlListsNotLinks() {
		NoteParse parse = scan("---\nrelated: [[Note]]\n---\n");
		assertThat(parse.links()).isEmpty();
		assertThat(data(parse).get("related")).isEqualTo(List.of(List.of("Note")));
	}

	@Test
	void emptyFrontmatterIsAnEmptyMapAndKeysAreStrings() {
		assertThat(data(scan("---\n---\nBody\n"))).isEmpty();
		assertThat(data(scan("---\n1: one\nnested:\n  k: v\n---\n"))).containsEntry("1", "one")
			.containsEntry("nested", Map.of("k", "v"));
	}

	@Test
	void unterminatedFrontmatterIsNotFrontmatter() {
		NoteParse parse = scan("---\ntags: [x]\nBody #y\n");
		assertThat(parse.frontmatter()).isNull();
		assertThat(parse.distinctTags()).containsExactly("y");
	}

	@Test
	void scalarRootIsAnError() {
		NoteParse parse = scan("---\njust text\n---\n");
		assertThat(parse.frontmatter().data()).isNull();
		assertThat(parse.frontmatterError()).isNotNull();
	}

}
