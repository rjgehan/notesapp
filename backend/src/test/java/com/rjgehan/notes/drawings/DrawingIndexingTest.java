package com.rjgehan.notes.drawings;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.BacklinkGroup;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.HeadingInfo;
import com.rjgehan.notes.api.dto.Mention;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.SearchHit;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.NoteService;
import com.rjgehan.notes.index.SearchService;
import com.rjgehan.notes.index.TagIndex;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static com.rjgehan.notes.drawings.DrawingFixtures.PLUGIN_FILE;
import static com.rjgehan.notes.drawings.DrawingFixtures.element;
import static com.rjgehan.notes.drawings.DrawingFixtures.excalidraw;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Drawings feed search, backlinks and tags through the DocumentIndexer (ROADMAP item 5, DESIGN §6.8.1). */
class DrawingIndexingTest {

	private static final String CLIENT = "client-d1";

	private static final String HOUSE = excalidraw(
			"{\"f1\": {\"mimeType\": \"image/png\", \"id\": \"f1\", \"created\": 1, \"path\": \"Attachments/photo.png\"}}",
			element("t1", "text", "\"text\": \"Call [[Plumber]] about\\nthe leak #home\", "
					+ "\"originalText\": \"Call [[Plumber]] about the leak #home\""),
			element("r1", "rectangle", "\"link\": \"[[Projects/Plan]]\""),
			element("r2", "rectangle", "\"link\": \"https://example.com/Plumber\""),
			element("i1", "image", "\"fileId\": \"f1\""));

	@TempDir
	Path dir;

	private TestVault vault;

	private NoteService notes;

	private SearchService search;

	@BeforeEach
	void setUp() throws IOException {
		for (String note : List.of("Plumber", "Projects/Plan", "World", "Orphan", "Linked", "Covered", "Synced",
				"Plan frame")) {
			write(note + ".md", "# " + note + "\n");
		}
		write("Attachments/photo.png", "not really a png");
		write("Drawings/House.excalidraw", HOUSE);
		write("Drawings/Plugin.excalidraw.md", PLUGIN_FILE);
		write("Drawings/Broken.excalidraw", "{\"type\": \"excalidraw\", \"elements\": [");
		this.vault = TestVault.start(this.dir);
		this.notes = new NoteService(this.vault.paths, this.vault.index, this.vault.kinds, this.vault.settings);
		this.search = new SearchService(this.vault.index, this.vault.settings);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private void write(String path, String content) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private String read(String path) throws IOException {
		return Files.readString(this.dir.resolve(path), StandardCharsets.UTF_8);
	}

	private List<BacklinkGroup> linked(String path) {
		return this.notes.backlinks(path, false).linked();
	}

	private List<String> contexts(String path, String source) {
		return linked(path).stream()
			.filter((group) -> group.source().equals(source))
			.flatMap((group) -> group.mentions().stream())
			.map(Mention::context)
			.toList();
	}

	private List<String> found(String query) {
		return this.search.search(query, 20, "relevance", false).results().stream().map(SearchHit::path).toList();
	}

	@Test
	void textsElementLinksAndImagesOfADrawingAreBacklinks() {
		assertThat(linked("Plumber.md")).extracting(BacklinkGroup::source).containsExactly("Drawings/House.excalidraw");
		assertThat(contexts("Plumber.md", "Drawings/House.excalidraw"))
			.containsExactly("Call [[Plumber]] about the leak #home");
		assertThat(contexts("Projects/Plan.md", "Drawings/House.excalidraw")).containsExactly("[[Projects/Plan]]");
		assertThat(linked("Attachments/photo.png")).extracting(BacklinkGroup::source)
			.containsExactly("Drawings/House.excalidraw");
	}

	@Test
	void searchFindsTheTextOfADrawingButNotItsJson() {
		assertThat(found("leak")).containsExactly("Drawings/House.excalidraw");
		assertThat(found("strokeColor")).isEmpty();
		assertThat(found("example")).isEmpty();
		assertThat(found("tag:home")).containsExactly("Drawings/House.excalidraw");
		List<String> tags = this.vault.index.tagStats().stream().map(TagIndex.TagStat::tag).toList();
		assertThat(tags).contains("home", "drawn");
	}

	@Test
	void aMarkdownDrawingLinksThroughItsMarkdownAndItsJson() {
		String source = "Drawings/Plugin.excalidraw.md";
		// The Markdown sections, as Obsidian sees them.
		assertThat(contexts("World.md", source)).containsExactly("Hello [[World]] ^Ab12Cd34");
		assertThat(contexts("Covered.md", source)).containsExactly("Rr11Ss22: [[Covered]]");
		assertThat(contexts("Synced.md", source)).containsExactly("See [[Synced]] ^Tt33Uu44");
		// What only the compressed JSON holds.
		assertThat(contexts("Orphan.md", source)).containsExactly("Orphan text [[Orphan]] #drawn");
		assertThat(contexts("Linked.md", source)).containsExactly("[[Linked]]");
		assertThat(found("Orphan")).contains(source);
		assertThat(found("frame")).contains(source);
	}

	@Test
	void aMarkdownDrawingStaysANoteWithItsOwnOutline() {
		assertThat(this.vault.index.stats().notes()).isEqualTo(9);
		assertThat(this.notes.meta("Drawings/Plugin.excalidraw.md").headings()).extracting(HeadingInfo::text)
			.containsExactly("Excalidraw Data", "Text Elements", "Element Links");
		assertThatThrownBy(() -> this.notes.meta("Drawings/House.excalidraw")).isInstanceOfSatisfying(
				NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		// "Plan frame" is a frame's name in the JSON: searchable, but never offered as a mention to link, which
		// would edit the file at an offset that is not in it.
		assertThat(this.notes.backlinks("Plan frame.md", true).unlinked()).isEmpty();
	}

	@Test
	void aRenameRewritesTheMarkdownAndReportsLinksOnlyTheJsonHolds() throws IOException {
		MoveResult world = this.vault.moves.move("World.md", "Earth.md", null, false, TestVault.ALICE, CLIENT);
		assertThat(world.failed()).isEmpty();
		assertThat(read("Drawings/Plugin.excalidraw.md")).contains("Hello [[Earth]] ^Ab12Cd34")
			.isEqualTo(PLUGIN_FILE.replace("Hello [[World]]", "Hello [[Earth]]"));

		String before = read("Drawings/Plugin.excalidraw.md");
		// Its JSON-only link would have to change to [[Chained]].
		MoveResult linkedMove = this.vault.moves.move("Linked.md", "Chained.md", null, false, TestVault.ALICE,
				CLIENT);
		assertThat(linkedMove.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Drawings/Plugin.excalidraw.md " + FailedReason.NOT_REWRITABLE);
		assertThat(read("Drawings/Plugin.excalidraw.md")).isEqualTo(before);

		MoveResult plumber = this.vault.moves.move("Plumber.md", "Contacts/Plumber Bob.md", null, false,
				TestVault.ALICE, CLIENT);
		assertThat(plumber.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Drawings/House.excalidraw " + FailedReason.NOT_REWRITABLE);
		assertThat(read("Drawings/House.excalidraw")).isEqualTo(HOUSE);
	}

	@Test
	void savedDrawingsAreIndexedAgain() throws IOException {
		String version = this.vault.index.file("Drawings/House.excalidraw").version();
		String edited = HOUSE.replace("Call [[Plumber]] about the leak", "Ask [[World]] about the roof");
		this.vault.files.saveText("Drawings/House.excalidraw", edited, version, false, TestVault.ALICE, CLIENT);
		assertThat(linked("Plumber.md")).isEmpty();
		assertThat(contexts("World.md", "Drawings/House.excalidraw")).containsExactly("Ask [[World]] about the roof #home");
		assertThat(found("roof")).containsExactly("Drawings/House.excalidraw");

		// A drawing that stops being readable keeps its file record and loses its content.
		version = this.vault.index.file("Drawings/House.excalidraw").version();
		this.vault.files.saveText("Drawings/House.excalidraw", "{", version, false, TestVault.ALICE, CLIENT);
		assertThat(this.vault.index.file("Drawings/House.excalidraw")).isNotNull();
		assertThat(linked("World.md")).extracting(BacklinkGroup::source).containsExactly("Drawings/Plugin.excalidraw.md");
		assertThat(found("roof")).isEmpty();
	}

	@Test
	void anUnreadableDrawingIsListedButNotSearched() {
		assertThat(this.vault.index.file("Drawings/Broken.excalidraw")).isNotNull();
		assertThat(found("excalidraw")).doesNotContain("Drawings/Broken.excalidraw");
	}

}
