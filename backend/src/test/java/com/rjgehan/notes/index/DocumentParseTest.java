package com.rjgehan.notes.index;

import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class DocumentParseTest {

	@Test
	void blocksAreScannedOnTheirOwnAndJoined() {
		DocumentParse.Parsed parsed = DocumentParse.of(new DocumentIndexer.Document(
				List.of("# Home", "Call [[Plumber]] #home", "```\nhidden [[Secret]]", "Then [[Bank]]")));
		assertThat(parsed.text()).isEqualTo("# Home\nCall [[Plumber]] #home\n```\nhidden [[Secret]]\nThen [[Bank]]");
		NoteParse parse = parsed.parse();
		// The fence left open in the third block does not hide the fourth.
		assertThat(parse.links()).extracting(LinkOcc::target).containsExactly("Plumber", "Bank");
		LinkOcc bank = parse.links().get(1);
		assertThat(parsed.text().substring(bank.from(), bank.to())).isEqualTo("[[Bank]]");
		assertThat(bank.line()).isEqualTo(4);
		assertThat(parsed.text().substring(bank.targetFrom(), bank.targetTo())).isEqualTo("Bank");
		// Offsets point into the search text, not the document's file, so a move must never splice them.
		assertThat(parse.links()).noneMatch(LinkOcc::rewritable);
		assertThat(parse.distinctTags()).containsExactly("home");
		TagOcc tag = parse.tags().get(0);
		assertThat(parsed.text().substring(tag.from(), tag.to())).isEqualTo("#home");
		assertThat(parse.headings()).extracting(HeadingOcc::text).containsExactly("Home");
		assertThat(parse.lineStarts()).containsExactly(0, 7, 30, 34, 52);
		assertThat(parse.frontmatter()).isNull();
	}

	@Test
	void aBlockIsNeverFrontmatter() {
		NoteParse parse = DocumentParse.of(new DocumentIndexer.Document(List.of("---\ntags: [x]\n---\n#real")))
			.parse();
		assertThat(parse.frontmatter()).isNull();
		assertThat(parse.distinctTags()).containsExactly("real");
	}

	@Test
	void anEmptyDocumentHasOneEmptyLine() {
		DocumentParse.Parsed parsed = DocumentParse.of(new DocumentIndexer.Document(List.of()));
		assertThat(parsed.text()).isEmpty();
		assertThat(parsed.parse().lineStarts()).containsExactly(0);
		assertThat(parsed.parse().links()).isEmpty();
	}

}
