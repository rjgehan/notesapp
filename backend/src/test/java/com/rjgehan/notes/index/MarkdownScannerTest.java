package com.rjgehan.notes.index;

import java.nio.charset.StandardCharsets;
import java.util.List;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.vault.TextCodec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import static org.assertj.core.api.Assertions.assertThat;

class MarkdownScannerTest {

	private static NoteParse scan(String text) {
		return MarkdownScanner.scan(text, false, false);
	}

	private static List<String> tags(String text) {
		return scan(text).tags().stream().map(TagOcc::tag).toList();
	}

	private static List<String> targets(String text) {
		return scan(text).links().stream().map(LinkOcc::target).toList();
	}

	// ------------------------------------------------------------ API.md §15.6 vectors

	static List<Arguments> tagVectors() {
		return List.of(Arguments.of("#project", List.of("project")),
				Arguments.of("#Project/Alpha", List.of("Project/Alpha")), Arguments.of("#a/b/", List.of("a/b")),
				Arguments.of("#1984", List.of()), Arguments.of("#y1984", List.of("y1984")), Arguments.of("a#b", List.of()),
				Arguments.of("#🚀 launch", List.of("🚀")), Arguments.of("#don’t", List.of("don’t")),
				Arguments.of("#don't", List.of("don")), Arguments.of("#tag.", List.of("tag")),
				Arguments.of("# Heading #tag", List.of("tag")), Arguments.of("[see #x](https://e.com)", List.of()),
				Arguments.of("`#code`", List.of()));
	}

	@ParameterizedTest
	@MethodSource("tagVectors")
	void sharedTagVectors(String input, List<String> expected) {
		assertThat(tags(input)).isEqualTo(expected);
	}

	static List<Arguments> wikiVectors() {
		return List.of(Arguments.of("[[Note]]", "Note", null, null, false),
				Arguments.of("[[ Note ]]", "Note", null, null, false),
				Arguments.of("[[Note\\|Alias]]", "Note", null, "Alias", false),
				Arguments.of("[[Note#H1#H2\\|x]]", "Note", "H1#H2", "x", false),
				Arguments.of("[[#Heading]]", "", "Heading", null, false), Arguments.of("[[]]", "", null, null, false),
				Arguments.of("[[Note#^abc]]", "Note", "^abc", null, false),
				Arguments.of("[[a|b|c]]", "a", null, "b|c", false),
				Arguments.of("![[pic.png|300]]", "pic.png", null, "300", true));
	}

	@ParameterizedTest
	@MethodSource("wikiVectors")
	void sharedWikilinkVectors(String input, String target, String subpath, String display, boolean embed) {
		List<LinkOcc> links = scan(input).links();
		assertThat(links).hasSize(1);
		LinkOcc link = links.get(0);
		assertThat(link.target()).isEqualTo(target);
		assertThat(link.subpath()).isEqualTo(subpath);
		assertThat(link.display()).isEqualTo(display);
		assertThat(link.embed()).isEqualTo(embed);
		assertThat(link.style()).isEqualTo(LinkStyle.WIKI);
		assertThat(link.raw()).isEqualTo(input);
		assertThat(link.from()).isZero();
		assertThat(link.to()).isEqualTo(input.length());
		assertThat(input.substring(link.targetFrom(), link.targetTo())).isEqualTo(target);
	}

	// ------------------------------------------------------------ links

	@Test
	void markdownLinks() {
		NoteParse parse = scan("""
				[a](<My Note.md>) [b](My%20Note.md) [c](a+b.md) [d](x.md "Title")
				[e](https://e.com) [f](//e.com/x) [g](#Heading) ![img](pics/p.png) [h](T.md#sub)
				""");
		List<LinkOcc> links = parse.links();
		assertThat(links).extracting(LinkOcc::target)
			.containsExactly("My Note.md", "My Note.md", "a+b.md", "x.md", "", "pics/p.png", "T.md");
		LinkOcc angle = links.get(0);
		assertThat(angle.angle()).isTrue();
		assertThat(angle.display()).isEqualTo("a");
		assertThat(angle.style()).isEqualTo(LinkStyle.MARKDOWN);
		assertThat(links.get(4).subpath()).isEqualTo("Heading");
		assertThat(links.get(5).embed()).isTrue();
		LinkOcc withSubpath = links.get(6);
		assertThat(withSubpath.subpath()).isEqualTo("sub");
		String text = "[h](T.md#sub)";
		assertThat(text.substring(4, 8)).isEqualTo("T.md");
		assertThat(withSubpath.targetTo() - withSubpath.targetFrom()).isEqualTo(4);
		LinkOcc encoded = links.get(1);
		String line = "[a](<My Note.md>) [b](My%20Note.md)";
		assertThat(line.substring(encoded.targetFrom(), encoded.targetTo())).isEqualTo("My%20Note.md");
	}

	@Test
	void tagsAreNotRecognizedInsideLinks() {
		assertThat(tags("[[Note #x]] [text #y](Other.md) #z")).containsExactly("z");
	}

	@Test
	void unicodeTags() {
		assertThat(tags("#café and #日本語 and #Ünïcödé")).containsExactly("café", "日本語", "Ünïcödé");
	}

	// ------------------------------------------------------------ exclusions

	@Test
	void fencedCodeIsExcluded() {
		String text = """
				before [[A]]
				```js
				[[B]] #b
				```
				between [[C]]
				~~~~
				[[D]]
				~~~
				still code [[E]]
				~~~~~
				after [[F]]
				""";
		assertThat(targets(text)).containsExactly("A", "C", "F");
	}

	@Test
	void unclosedFenceRunsToTheEnd() {
		assertThat(targets("[[A]]\n```\n[[B]]\n[[C]]\n")).containsExactly("A");
	}

	@Test
	void backtickFenceInfoMayNotContainBackticks() {
		assertThat(targets("```not`a fence\n[[A]]\n")).containsExactly("A");
	}

	@Test
	void inlineCodeIsExcluded() {
		assertThat(targets("`[[A]]` [[B]] ``x ` [[C]]`` ` [[D]]")).containsExactly("B", "D");
		assertThat(tags("`#a` #b")).containsExactly("b");
	}

	@Test
	void commentsAndMathAreExcluded() {
		assertThat(targets("%%[[A]]%% [[B]] %%\nmulti [[C]]\nline%% [[D]]")).containsExactly("B", "D");
		assertThat(targets("<!-- [[A]]\n[[B]] --> [[C]]")).containsExactly("C");
		assertThat(targets("$$\n[[A]] #t\n$$\n[[B]]")).containsExactly("B");
		assertThat(targets("costs $$ only [[A]]")).containsExactly("A");
		assertThat(tags("%% #hidden %% #shown")).containsExactly("shown");
	}

	@Test
	void indentedCodeIsNotExcluded() {
		assertThat(targets("- item\n    [[Continued]]\n")).containsExactly("Continued");
	}

	// ------------------------------------------------------------ headings and block ids

	@Test
	void atxHeadings() {
		NoteParse parse = scan("# One\n## Two ##\n   ### Three\n####### Seven\n#NoSpace\n# C#\n#\n");
		assertThat(parse.headings()).containsExactly(new HeadingOcc(1, "One", 0), new HeadingOcc(2, "Two", 1),
				new HeadingOcc(3, "Three", 2), new HeadingOcc(1, "C#", 5), new HeadingOcc(1, "", 6));
	}

	@Test
	void setextHeadings() {
		NoteParse parse = scan("Title\n=====\n\nSub\n---\n\n- item\n---\n\ntext\n");
		assertThat(parse.headings()).containsExactly(new HeadingOcc(1, "Title", 0), new HeadingOcc(2, "Sub", 3));
	}

	@Test
	void frontmatterClosingLineIsNotASetextUnderline() {
		NoteParse parse = scan("---\ntitle: x\n---\nBody\n");
		assertThat(parse.headings()).isEmpty();
		assertThat(parse.frontmatter()).isNotNull();
	}

	@Test
	void headingsInsideCodeAreIgnored() {
		assertThat(scan("```\n# Not\n```\n# Yes\n").headings()).containsExactly(new HeadingOcc(1, "Yes", 3));
	}

	@Test
	void blockIds() {
		assertThat(scan("A paragraph ^abc-1\n^solo\nnot^id\n`code ^x`\n").blockIds()).containsExactly("abc-1", "solo");
	}

	// ------------------------------------------------------------ offsets

	@Test
	void offsetsAreUtf16AfterSurrogatePairs() {
		String text = "🚀 [[Note]] #tag";
		NoteParse parse = scan(text);
		LinkOcc link = parse.links().get(0);
		assertThat(link.from()).isEqualTo(3);
		assertThat(text.substring(link.from(), link.to())).isEqualTo("[[Note]]");
		TagOcc tag = parse.tags().get(0);
		assertThat(text.substring(tag.from(), tag.to())).isEqualTo("#tag");
	}

	@Test
	void bomFilesHaveFrontmatterAndBomStrippedOffsets() {
		byte[] bytes = TextCodec.encode("---\ntags: [x]\n---\n[[Note]]\n", true);
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		assertThat(decoded.hadBom()).isTrue();
		NoteParse parse = MarkdownScanner.scan(decoded.text(), decoded.hadBom(), decoded.lossy());
		assertThat(parse.frontmatter()).isNotNull();
		assertThat(parse.hadBom()).isTrue();
		assertThat(parse.distinctTags()).containsExactly("x");
		LinkOcc link = parse.links().get(0);
		assertThat(decoded.text().substring(link.from(), link.to())).isEqualTo("[[Note]]");
		assertThat(link.from()).isEqualTo("---\ntags: [x]\n---\n".length());
	}

	@Test
	void crlfCountsAsTwoCodeUnits() {
		String text = "---\r\ntags: [x]\r\n---\r\nline one\r\n[[Note]] #t\r\n";
		NoteParse parse = scan(text);
		assertThat(parse.frontmatter()).isNotNull();
		LinkOcc link = parse.links().get(0);
		assertThat(link.line()).isEqualTo(4);
		assertThat(link.from()).isEqualTo(text.indexOf("[[Note]]"));
		assertThat(parse.tags()).extracting(TagOcc::tag).containsExactly("x", "t");
		assertThat(parse.lineStarts()[4]).isEqualTo(text.indexOf("[[Note]]"));
	}

	@Test
	void lossyFlagIsCarried() {
		TextCodec.Decoded decoded = TextCodec.decode(new byte[] { 'a', (byte) 0xFF, 'b' });
		assertThat(decoded.lossy()).isTrue();
		assertThat(decoded.text()).isEqualTo("a�b");
		assertThat(MarkdownScanner.scan(decoded.text(), false, true).lossy()).isTrue();
		assertThat(new String(TextCodec.encode("é", false), StandardCharsets.UTF_8)).isEqualTo("é");
	}

}
