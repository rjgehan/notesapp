package com.rjgehan.notes.canvas;

import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.index.DocumentParse;
import com.rjgehan.notes.index.HeadingOcc;
import com.rjgehan.notes.index.LinkOcc;
import com.rjgehan.notes.index.NoteParse;
import com.rjgehan.notes.support.TestVault;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * JSON Canvas indexing (ROADMAP item 25) through the {@link DocumentIndexer} extension point: searchable blocks, links
 * from cards and file nodes, tags, and the rewrite after a move.
 */
class CanvasDocumentIndexerTest {

	private final CanvasDocumentIndexer indexer = new CanvasDocumentIndexer(TestVault.JSON);

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

	private List<String> blocks(String path, String text) {
		DocumentIndexer.Document document = this.indexer.index(path, text);
		assertThat(document).isNotNull();
		return document.blocks();
	}

	@Test
	void canvasesAreSupportedByExtension() {
		assertThat(this.indexer.supports("Boards/Sprint.canvas")).isTrue();
		assertThat(this.indexer.supports("Boards/Sprint.CANVAS")).isTrue();
		assertThat(this.indexer.supports("Boards/Sprint.md")).isFalse();
		assertThat(this.indexer.supports("Boards/canvas.json")).isFalse();
	}

	@Test
	void eachItemIsABlockInFileOrder() {
		assertThat(blocks("Board.canvas", CANVAS)).containsExactly("Sprint board",
				"# Goals\nShip [[Plan]] and #release/q4\n\n```\nnot [[Code]]", "![Spec.md](/Projects/Spec.md#Scope)",
				"https://example.com/docs", "---\nnot: frontmatter\n---\nSee [[Later]]", "details in [[Spec]]");
	}

	@Test
	void linksComeFromCardsLabelsAndFileNodes() {
		DocumentParse.Parsed parsed = DocumentParse.of(new DocumentIndexer.Document(blocks("Board.canvas", CANVAS)));
		List<LinkOcc> links = parsed.parse().links();
		assertThat(links).extracting(LinkOcc::target).containsExactly("Plan", "/Projects/Spec.md", "Later", "Spec");
		for (LinkOcc link : links) {
			// Offsets point into the search text; a move rewrites the canvas through its indexer instead.
			assertThat(parsed.text().substring(link.from(), link.to())).isEqualTo(link.raw());
			assertThat(link.rewritable()).isFalse();
		}
		LinkOcc file = links.get(1);
		assertThat(file.subpath()).isEqualTo("Scope");
		assertThat(file.embed()).isTrue();
		assertThat(file.style()).isEqualTo(LinkStyle.MARKDOWN);
	}

	@Test
	void eachCardIsScannedOnItsOwn() {
		NoteParse parse = DocumentParse.of(new DocumentIndexer.Document(blocks("Board.canvas", CANVAS))).parse();
		// The unclosed fence hides [[Code]] in its own card only; the next card's "---" is no frontmatter.
		assertThat(parse.links()).extracting(LinkOcc::target).doesNotContain("Code").contains("Later");
		assertThat(parse.frontmatter()).isNull();
		assertThat(parse.aliases()).isEmpty();
		assertThat(parse.distinctTags()).containsExactly("release/q4");
		assertThat(parse.headings()).extracting(HeadingOcc::text).contains("Goals");
	}

	@Test
	void fileNodesBecomeExactEmbeds() {
		assertThat(CanvasDocumentIndexer.embed("Notes/A [1] (draft).md", null))
			.isEqualTo("![A  1  (draft).md](/Notes/A%20%5B1%5D%20%28draft%29.md)");
		assertThat(CanvasDocumentIndexer.embed("Notes/A.md", "#My Heading"))
			.isEqualTo("![A.md](/Notes/A.md#My%20Heading)");
		assertThat(CanvasDocumentIndexer.embed("Notes/A.md", "#^block1")).isEqualTo("![A.md](/Notes/A.md#%5Eblock1)");
	}

	@Test
	void emptyAndBrokenFiles() {
		assertThat(blocks("New.canvas", "")).isEmpty();
		assertThat(blocks("New.canvas", "{\n\t\"nodes\":[],\n\t\"edges\":[]\n}")).isEmpty();
		assertThat(this.indexer.index("Broken.canvas", "{\"nodes\": [")).isNull();
		assertThat(this.indexer.index("List.canvas", "[1, 2]")).isNull();
		assertThat(blocks("Odd.canvas", "{\"nodes\":{\"a\":{\"type\":\"text\",\"text\":\"x\"}},\"edges\":[1,{\"label\":2}]}"))
			.isEmpty();
	}

	@Test
	void aMoveRewritesCardsLabelsAndFileNodesInPlace() {
		DocumentIndexer.LinkRewriter links = rewriter(Map.of("[[Plan]]", "[[Archive/Plan]]", "[[Spec]]", "[[Specs/Spec]]"),
				Map.of("Projects/Spec.md", "Specs/Spec.md"));
		DocumentIndexer.Rewritten rewritten = this.indexer.rewriteLinks("Board.canvas", CANVAS, links);
		assertThat(rewritten).isNotNull();
		assertThat(rewritten.links()).isEqualTo(3);
		assertThat(rewritten.text()).isEqualTo(CANVAS.replace("Ship [[Plan]]", "Ship [[Archive/Plan]]")
			.replace("\"file\":\"Projects/Spec.md\"", "\"file\":\"Specs/Spec.md\"")
			.replace("details in [[Spec]]", "details in [[Specs/Spec]]"));
	}

	@Test
	void aCanvasWithoutMovedLinksIsUnchangedAndAnUnwritableCardStopsTheRewrite() {
		DocumentIndexer.Rewritten none = this.indexer.rewriteLinks("Board.canvas", CANVAS, rewriter(Map.of(), Map.of()));
		assertThat(none).isNotNull();
		assertThat(none.links()).isZero();
		assertThat(none.text()).isSameAs(CANVAS);
		DocumentIndexer.LinkRewriter refusing = new DocumentIndexer.LinkRewriter() {

			@Override
			public DocumentIndexer.@Nullable Rewritten markdown(String fragment) {
				return null;
			}

			@Override
			public String path(String path) {
				return path;
			}

		};
		assertThat(this.indexer.rewriteLinks("Board.canvas", CANVAS, refusing)).isNull();
		assertThat(this.indexer.rewriteLinks("Broken.canvas", "{\"nodes\": [", refusing)).isNull();
	}

	@Test
	void escapedStringsAreReplacedWhole() {
		String text = "{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"Say \\\"hi\\\" to [[Plan]]\\n\\u00e9\"}],\"edges\":[]}";
		DocumentIndexer.Rewritten rewritten = this.indexer.rewriteLinks("Board.canvas", text,
				rewriter(Map.of("[[Plan]]", "[[Archive/Plan]]"), Map.of()));
		assertThat(rewritten).isNotNull();
		assertThat(rewritten.text())
			.isEqualTo("{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"Say \\\"hi\\\" to [[Archive/Plan]]\\né\"}],\"edges\":[]}");
		assertThat(TestVault.JSON.readTree(rewritten.text()).path("nodes").get(0).path("text").asString())
			.isEqualTo("Say \"hi\" to [[Archive/Plan]]\né");
	}

	/** Rewrites by plain substitution, standing in for the index's rewriter. */
	private static DocumentIndexer.LinkRewriter rewriter(Map<String, String> markdown, Map<String, String> paths) {
		return new DocumentIndexer.LinkRewriter() {

			@Override
			public DocumentIndexer.Rewritten markdown(String fragment) {
				String text = fragment;
				int count = 0;
				for (Map.Entry<String, String> entry : markdown.entrySet()) {
					if (text.contains(entry.getKey())) {
						text = text.replace(entry.getKey(), entry.getValue());
						count++;
					}
				}
				return new DocumentIndexer.Rewritten(text, count);
			}

			@Override
			public String path(String path) {
				return paths.getOrDefault(path, path);
			}

		};
	}

}
