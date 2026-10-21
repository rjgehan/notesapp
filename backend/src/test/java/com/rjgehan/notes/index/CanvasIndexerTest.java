package com.rjgehan.notes.index;

import java.util.List;

import com.rjgehan.notes.api.dto.LinkStyle;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** JSON Canvas indexing (ROADMAP item 25): searchable text, links from cards and file nodes, tags. */
class CanvasIndexerTest {

	private final CanvasIndexer indexer = new CanvasIndexer();

	/** As Obsidian writes it: tabs, one node per line, unknown fields. */
	private static final String CANVAS = String.join("\n", "{", "\t\"nodes\":[",
			"\t\t{\"id\":\"g\",\"type\":\"group\",\"x\":0,\"y\":0,\"width\":900,\"height\":600,\"label\":\"Sprint board\"},",
			"\t\t{\"id\":\"t\",\"type\":\"text\",\"text\":\"# Goals\\nShip [[Plan]] and #release/q4\\n\\n```\\nnot [[Code]]\",\"x\":20,\"y\":20,\"width\":250,\"height\":60,\"styleAttributes\":{}},",
			"\t\t{\"id\":\"f\",\"type\":\"file\",\"file\":\"Projects/Spec.md\",\"subpath\":\"#Scope\",\"x\":300,\"y\":20,\"width\":400,\"height\":400},",
			"\t\t{\"id\":\"l\",\"type\":\"link\",\"url\":\"https://example.com/docs\",\"x\":0,\"y\":500,\"width\":400,\"height\":120},",
			"\t\t{\"id\":\"u\",\"type\":\"widget\",\"x\":0,\"y\":0,\"width\":1,\"height\":1},",
			"\t\t{\"id\":\"t2\",\"type\":\"text\",\"text\":\"---\\nnot: frontmatter\\n---\\nSee [[Later]]\",\"x\":20,\"y\":200,\"width\":250,\"height\":60}",
			"\t],", "\t\"edges\":[",
			"\t\t{\"id\":\"e\",\"fromNode\":\"t\",\"fromSide\":\"right\",\"toNode\":\"f\",\"toSide\":\"left\",\"label\":\"details in [[Spec]]\"}",
			"\t]", "}");

	@Test
	void canvasesAreSupportedByExtension() {
		assertThat(this.indexer.supports("Boards/Sprint.canvas")).isTrue();
		assertThat(this.indexer.supports("Boards/Sprint.CANVAS")).isTrue();
		assertThat(this.indexer.supports("Boards/Sprint.md")).isFalse();
		assertThat(this.indexer.supports("Boards/canvas.json")).isFalse();
	}

	@Test
	void theSearchableTextHasOneBlockPerItem() {
		DocumentIndexer.Indexed indexed = this.indexer.index("Board.canvas", CANVAS);
		assertThat(indexed).isNotNull();
		assertThat(indexed.searchText()).isEqualTo(String.join("\n\n", "Sprint board",
				"# Goals\nShip [[Plan]] and #release/q4\n\n```\nnot [[Code]]", "Projects/Spec.md#Scope",
				"https://example.com/docs", "---\nnot: frontmatter\n---\nSee [[Later]]", "details in [[Spec]]"));
	}

	@Test
	void linksComeFromCardsLabelsAndFileNodes() {
		DocumentIndexer.Indexed indexed = this.indexer.index("Board.canvas", CANVAS);
		assertThat(indexed).isNotNull();
		String text = indexed.searchText();
		List<LinkOcc> links = indexed.parse().links();
		assertThat(links).extracting(LinkOcc::target).containsExactly("Plan", "Projects/Spec.md", "Later", "Spec");
		for (LinkOcc link : links) {
			// Offsets and lines point into the searchable text, and nothing is ever spliced by a move.
			assertThat(text.substring(link.from(), link.to())).isEqualTo(link.raw());
			assertThat(text.split("\n", -1)[link.line()]).contains(link.raw());
			assertThat(link.rewritable()).isFalse();
		}
		LinkOcc file = links.get(1);
		assertThat(file.raw()).isEqualTo("Projects/Spec.md#Scope");
		assertThat(file.subpath()).isEqualTo("Scope");
		assertThat(file.embed()).isTrue();
		assertThat(file.style()).isEqualTo(LinkStyle.WIKI);
		assertThat(text.substring(file.targetFrom(), file.targetTo())).isEqualTo("Projects/Spec.md");
	}

	@Test
	void eachCardIsScannedOnItsOwn() {
		DocumentIndexer.Indexed indexed = this.indexer.index("Board.canvas", CANVAS);
		assertThat(indexed).isNotNull();
		NoteParse parse = indexed.parse();
		// The unclosed fence hides [[Code]] in its own card only; the next card's "---" is no frontmatter.
		assertThat(parse.links()).extracting(LinkOcc::target).doesNotContain("Code").contains("Later");
		assertThat(parse.frontmatter()).isNull();
		assertThat(parse.aliases()).isEmpty();
		assertThat(parse.distinctTags()).containsExactly("release/q4");
		// "---" after a line makes it a heading, as Obsidian renders the card.
		assertThat(parse.headings()).extracting(HeadingOcc::text).containsExactly("Goals", "not: frontmatter");
		int goals = parse.headings().get(0).line();
		assertThat(indexed.searchText().split("\n", -1)[goals]).isEqualTo("# Goals");
	}

	@Test
	void emptyAndBrokenFiles() {
		DocumentIndexer.Indexed empty = this.indexer.index("New.canvas", "");
		assertThat(empty).isNotNull();
		assertThat(empty.searchText()).isEmpty();
		assertThat(empty.parse().links()).isEmpty();
		DocumentIndexer.Indexed bare = this.indexer.index("New.canvas", "{\n\t\"nodes\":[],\n\t\"edges\":[]\n}");
		assertThat(bare).isNotNull();
		assertThat(bare.searchText()).isEmpty();
		assertThat(this.indexer.index("Broken.canvas", "{\"nodes\": [")).isNull();
		assertThat(this.indexer.index("List.canvas", "[1, 2]")).isNull();
		DocumentIndexer.Indexed odd = this.indexer.index("Odd.canvas", "{\"nodes\":{\"a\":1},\"edges\":[1,{\"label\":2}]}");
		assertThat(odd).isNotNull();
		assertThat(odd.searchText()).isEmpty();
	}

}
