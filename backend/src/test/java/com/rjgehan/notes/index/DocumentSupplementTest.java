package com.rjgehan.notes.index;

import java.util.List;

import com.rjgehan.notes.api.dto.TextRange;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** A note that a DocumentIndexer supports too: its blocks follow the note's text (DocumentParse#supplement). */
class DocumentSupplementTest {

	private static DocumentParse.Parsed supplement(String note, String... blocks) {
		NoteParse parse = MarkdownScanner.scan(note, false, false);
		return DocumentParse.supplement(note, parse, new DocumentIndexer.Document(List.of(blocks)));
	}

	@Test
	void blocksFollowTheNotesLastLine() {
		String note = "---\naliases: [Diagram]\n---\n# Title\nSee [[Here]] ^abc123\n";
		DocumentParse.Parsed parsed = supplement(note, "# Not a heading of the note", "Go [[There]] #drawn");
		assertThat(parsed.text()).isEqualTo(note + "# Not a heading of the note\nGo [[There]] #drawn");
		NoteParse parse = parsed.parse();
		assertThat(parse.lineStarts()).containsExactly(0, 4, 23, 27, 35, 56, 84);
		LinkOcc here = parse.links().get(0);
		assertThat(here.rewritable()).isTrue();
		LinkOcc there = parse.links().get(1);
		assertThat(there.target()).isEqualTo("There");
		assertThat(there.line()).isEqualTo(6);
		assertThat(parsed.text().substring(there.from(), there.to())).isEqualTo("[[There]]");
		assertThat(there.rewritable()).isFalse();
		assertThat(parse.distinctTags()).containsExactly("drawn");
		TagOcc tag = parse.tags().get(0);
		assertThat(parsed.text().substring(tag.from(), tag.to())).isEqualTo("#drawn");
		// What the note's own text decides stays the note's.
		assertThat(parse.frontmatter()).isNotNull();
		assertThat(parse.aliases()).containsExactly("Diagram");
		assertThat(parse.headings()).extracting(HeadingOcc::text).containsExactly("Title");
		assertThat(parse.blockIds()).containsExactly("abc123");
		// No mention may be linked inside the supplement: its offsets are not the file's.
		assertThat(parse.excluded()).contains(new TextRange(note.length(), parsed.text().length()));
	}

	@Test
	void aNoteWithoutAFinalLineBreakGetsOne() {
		DocumentParse.Parsed parsed = supplement("Last line", "[[There]]");
		assertThat(parsed.text()).isEqualTo("Last line\n[[There]]");
		assertThat(parsed.parse().lineStarts()).containsExactly(0, 10);
		assertThat(parsed.parse().links().get(0).line()).isEqualTo(1);
		assertThat(parsed.parse().links().get(0).from()).isEqualTo(10);
	}

	@Test
	void anEmptyNoteIsAllSupplement() {
		DocumentParse.Parsed parsed = supplement("", "[[There]]");
		assertThat(parsed.text()).isEqualTo("[[There]]");
		assertThat(parsed.parse().lineStarts()).containsExactly(0);
		assertThat(parsed.parse().links().get(0).line()).isZero();
	}

	@Test
	void mentionsAreNotFoundInTheSupplement() {
		String note = "Plumber in the note\n";
		DocumentParse.Parsed parsed = supplement(note, "Plumber in the drawing");
		List<MentionFinder.Found> found = MentionFinder.find(parsed.text(), parsed.parse(), List.of("Plumber"));
		assertThat(found).extracting(MentionFinder.Found::from).containsExactly(0);
	}

}
