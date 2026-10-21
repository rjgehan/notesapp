package com.rjgehan.notes.drawings;

import java.time.Duration;
import java.util.List;

import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;

import static com.rjgehan.notes.drawings.DrawingFixtures.PLUGIN_FILE;
import static com.rjgehan.notes.drawings.DrawingFixtures.PLUGIN_HEAD;
import static com.rjgehan.notes.drawings.DrawingFixtures.PLUGIN_SECTIONS;
import static com.rjgehan.notes.drawings.DrawingFixtures.element;
import static com.rjgehan.notes.drawings.DrawingFixtures.excalidraw;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

class ExcalidrawDocumentIndexerTest {

	private final ExcalidrawDocumentIndexer indexer = new ExcalidrawDocumentIndexer(TestVault.JSON);

	private List<String> blocks(String path, String text) {
		DocumentIndexer.Document document = this.indexer.index(path, text);
		assertThat(document).isNotNull();
		return document.blocks();
	}

	@Test
	void supportsBothDrawingFormats() {
		assertThat(this.indexer.supports("Plans/House.excalidraw")).isTrue();
		assertThat(this.indexer.supports("Plans/House.Excalidraw.MD")).isTrue();
		assertThat(this.indexer.supports("House.md")).isFalse();
		assertThat(this.indexer.supports("House.excalidraw.json")).isFalse();
		assertThat(this.indexer.supports("House.sheet")).isFalse();
	}

	@Test
	void textsLinksAndAttachmentsOfADrawingAreBlocks() {
		String text = excalidraw("{\"f1\": {\"mimeType\": \"image/png\", \"id\": \"f1\", \"path\": \"Attachments/a [1].png\"},"
				+ " \"f2\": {\"mimeType\": \"image/png\", \"id\": \"f2\", \"dataURL\": \"data:image/png;base64,AAAA\"}}",
				element("t1", "text", "\"text\": \"Call [[Plumber]]\\nabout the\", "
						+ "\"originalText\": \"Call [[Plumber]] about the leak #home\""),
				element("r1", "rectangle", "\"link\": \"[[Projects/Plan|the plan]]\""),
				element("r2", "ellipse", "\"link\": \"Projects/My%20Notes.md#Costs\""),
				element("r3", "diamond", "\"link\": \"https://example.com/x\""),
				element("i1", "image", "\"fileId\": \"f1\", \"status\": \"saved\""),
				element("i2", "image", "\"fileId\": \"f2\""),
				element("fr", "frame", "\"name\": \"Ground\\nfloor\""),
				element("t2", "text", "\"text\": \"plain\""));
		assertThat(blocks("House.excalidraw", text)).containsExactly("Call [[Plumber]] about the leak #home",
				"[[Projects/Plan|the plan]]", "[Projects/My%20Notes.md#Costs](Projects/My%20Notes.md#Costs)",
				"![a  1 .png](/Attachments/a%20%5B1%5D.png)", "Ground floor", "plain");
	}

	@Test
	void deletedElementsAndOtherPropertiesAreSkipped() {
		String text = excalidraw("{}",
				element("t1", "text", "\"text\": \"Gone [[Deleted]]\", \"isDeleted\": true"),
				element("t2", "text", "\"text\": 42, \"link\": null, \"customData\": {\"text\": \"nested [[No]]\"}"),
				element("t3", "text", "\"rawText\": \"Raw [[Source]]\", \"originalText\": \"Raw Source\""));
		assertThat(blocks("A.excalidraw", text)).containsExactly("Raw [[Source]]");
	}

	@Test
	void unreadableDrawingsAreNotIndexed() {
		assertThat(this.indexer.index("A.excalidraw", "{not json")).isNull();
		assertThat(this.indexer.index("A.excalidraw", "[1, 2]")).isNull();
		assertThat(this.indexer.index("A.excalidraw", "{\"type\": \"sheet\", \"elements\": []}")).isNull();
		assertThat(this.indexer.index("A.excalidraw", "{\"elements\": [{\"type\": \"text\"}]}")).isNull();
		assertThat(this.indexer.index("A.excalidraw", "{\"elements\": [null]}")).isNull();
		assertThat(this.indexer.index("A.excalidraw", "{\"elements\": {}}")).isNull();
		// An empty file, or one without elements, is an empty drawing.
		assertThat(blocks("A.excalidraw", "")).isEmpty();
		assertThat(blocks("A.excalidraw", "{\"type\": \"excalidraw\", \"elements\": null}")).isEmpty();
	}

	@Test
	void elementLinksBecomeMarkdownTheScannerResolvesLikeTheEditor() {
		assertThat(ExcalidrawDocumentIndexer.linkMarkup(" [[Note#Heading]] ")).isEqualTo("[[Note#Heading]]");
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("Folder/Note.md")).isEqualTo("[Folder/Note.md](Folder/Note.md)");
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("My Note")).isEqualTo("[My Note](<My Note>)");
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("[x](y)")).isEqualTo("[ x (y)](<[x](y)>)");
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("https://example.com")).isNull();
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("obsidian://open?vault=x")).isNull();
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("//cdn.example.com/x")).isNull();
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("a <b>")).isNull();
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("two\nlines")).isNull();
		assertThat(ExcalidrawDocumentIndexer.linkMarkup("   ")).isNull();
	}

	@Test
	void aMarkdownDrawingIsSupplementedWithWhatOnlyItsJsonHolds() {
		// Covered by the Markdown: Hello [[World]] (Text Elements), [[Covered]] (Element Links), and [[Synced]],
		// which the plugin derives from the text that holds it. The deleted text is gone.
		assertThat(blocks("Plugin.excalidraw.md", PLUGIN_FILE)).containsExactly("Orphan text [[Orphan]] #drawn",
				"[[Linked]]", "Plan frame");
		assertThat(blocks("Plugin.excalidraw.md", PLUGIN_FILE.replace("\n", "\r\n"))).containsExactly(
				"Orphan text [[Orphan]] #drawn", "[[Linked]]", "Plan frame");
	}

	@Test
	void aPlainJsonMarkdownDrawingIsReadToo() {
		String json = excalidraw("{}", element("Ab12Cd34", "text", "\"text\": \"Hello [[World]]\""),
				element("Qq77Ww00", "text", "\"text\": \"Only in [[Json]]\""),
				element("long-id-0123456789abcd", "arrow", "\"link\": \"[[Target]]\""));
		String file = PLUGIN_HEAD + "## Text Elements\nHello [[World]] ^Ab12Cd34\n\n%%\n# Drawing\n```json\n" + json
				+ "```\n%%\n";
		assertThat(blocks("A.excalidraw.md", file)).containsExactly("Only in [[Json]]", "[[Target]]");
	}

	@Test
	void aCraftedFileOfUnclosedBlocksIsScannedInLinearTime() {
		String crafted = PLUGIN_HEAD + "## Drawing\n```json\n".repeat(60_000);
		assertTimeoutPreemptively(Duration.ofSeconds(5), () -> {
			assertThat(MarkdownDrawing.parse(crafted)).isNull();
			assertThat(this.indexer.index("A.excalidraw.md", crafted)).isNull();
		});
		// The nearest closing fence after the last heading still closes it.
		MarkdownDrawing closed = MarkdownDrawing.parse(crafted + "{\"elements\": []}\n```\n");
		assertThat(closed).isNotNull();
		assertThat(closed.json()).isEqualTo("{\"elements\": []}");
	}

	@Test
	void anOlderPluginLayoutListsElementLinksAsTextEntries() {
		String json = excalidraw("{}", element("Rr11Ss22", "rectangle", "\"link\": \"[[Old]]\""));
		String file = PLUGIN_HEAD + "## Text Elements\n[[Old]] ^Rr11Ss22\n\n%%\n## Drawing\n```json\n" + json
				+ "```\n%%\n";
		assertThat(blocks("A.excalidraw.md", file)).isEmpty();
	}

	@Test
	void markdownWithoutAReadableDrawingIsOnlyANote() {
		assertThat(this.indexer.index("A.excalidraw.md", "# Just a note\n\n## Drawing\nno block\n")).isNull();
		assertThat(this.indexer.index("A.excalidraw.md", PLUGIN_HEAD + PLUGIN_SECTIONS)).isNull();
		String corrupt = PLUGIN_HEAD + "%%\n## Drawing\n```compressed-json\n/////////\n```\n%%\n";
		assertThat(this.indexer.index("A.excalidraw.md", corrupt)).isNull();
		String truncated = PLUGIN_FILE.replace("UAAQk1zuo5+gJT9PElSZAgKEMEkRoMAMogDKQA=", "");
		assertThat(this.indexer.index("A.excalidraw.md", truncated)).isNull();
		String notJson = PLUGIN_HEAD + "%%\n## Drawing\n```json\n{\"elements\": 3}\n```\n%%\n";
		assertThat(this.indexer.index("A.excalidraw.md", notJson)).isNull();
	}

}
