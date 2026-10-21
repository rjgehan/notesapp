package com.rjgehan.notes.index;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.BacklinkGroup;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.HeadingRenameResult;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.SearchHit;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Task lists and drawings side by side, each through its own {@link DocumentIndexer} (ROADMAP items 4 and 5, DESIGN
 * §6.8): one vault feeds search, tags and backlinks from both, and a rename rewrites the links each can write back (a
 * {@code .tasks} list as a whole, an {@code .excalidraw.md} drawing's Markdown as a note's) while an {@code .excalidraw}
 * drawing is reported as {@code not-rewritable} and left as it is.
 */
class DocumentIndexersTest {

	private static final String CLIENT = "client-docs";

	private static final String LIST = """
			{"type": "notesapp-tasks", "version": 1, "list": {"id": "HOME", "name": "Home", "order": "a0"},
			 "tasks": [
			  {"id": "T1", "title": "Call [[Plumber]] about the leak #home", "links": ["Projects/Plan.md"]},
			  {"id": "T2", "title": "Buy paint", "notes": "Ask the [[Plumber]] which one"}
			 ]}
			""";

	private static final String HOUSE = """
			{
			  "type": "excalidraw",
			  "version": 2,
			  "source": "https://excalidraw.com",
			  "elements": [
			    {"id": "t1", "type": "text", "isDeleted": false, "text": "Ask [[Plumber]] about the roof #home",
			     "originalText": "Ask [[Plumber]] about the roof #home"}
			  ],
			  "appState": {"viewBackgroundColor": "#ffffff"},
			  "files": {}
			}
			""";

	/**
	 * An Obsidian Excalidraw drawing with an uncompressed scene: one text and one element link listed in its Markdown
	 * sections (both linking the plumber), and one text only its JSON holds.
	 */
	private static final String SHED = """
			---

			excalidraw-plugin: parsed
			tags: [excalidraw]

			---

			# Excalidraw Data

			## Text Elements
			Fix the shed with [[Plumber]] ^Ab12Cd34

			## Element Links
			Rr11Ss22: [[Plumber]]

			%%
			## Drawing
			```json
			{
				"type": "excalidraw",
				"version": 2,
				"source": "https://github.com/zsviczian/obsidian-excalidraw-plugin",
				"elements": [
					{"id": "Ab12Cd34", "type": "text", "isDeleted": false, "text": "Fix the shed with Plumber",
					 "rawText": "Fix the shed with [[Plumber]]", "originalText": "Fix the shed with Plumber"},
					{"id": "Rr11Ss22", "type": "rectangle", "isDeleted": false, "link": "[[Plumber]]"},
					{"id": "Zz99Yy88", "type": "text", "isDeleted": false, "text": "Paint the shed with [[Painter]] #shed",
					 "rawText": "Paint the shed with [[Painter]] #shed"}
				],
				"appState": {},
				"files": {}
			}
			```
			%%""";

	@TempDir
	Path dir;

	private TestVault vault;

	private NoteService notes;

	private SearchService search;

	@BeforeEach
	void setUp() throws IOException {
		write("Plumber.md", "# Plumber\n");
		write("Painter.md", "# Painter\n");
		write("Projects/Plan.md", "# Plan\n");
		write("Tasks/Home.tasks", LIST);
		write("Drawings/House.excalidraw", HOUSE);
		write("Drawings/Shed.excalidraw.md", SHED);
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

	private List<String> sources(String path) {
		return this.notes.backlinks(path, false).linked().stream().map(BacklinkGroup::source).toList();
	}

	private List<String> found(String query) {
		return this.search.search(query, 20, "relevance", false).results().stream().map(SearchHit::path).toList();
	}

	@Test
	void searchTagsAndBacklinksSeeListsAndDrawings() {
		assertThat(found("leak")).containsExactly("Tasks/Home.tasks");
		assertThat(found("roof")).containsExactly("Drawings/House.excalidraw");
		assertThat(found("paint")).containsExactlyInAnyOrder("Tasks/Home.tasks", "Drawings/Shed.excalidraw.md");
		assertThat(found("tag:home")).containsExactlyInAnyOrder("Tasks/Home.tasks", "Drawings/House.excalidraw");
		assertThat(found("tag:shed")).containsExactly("Drawings/Shed.excalidraw.md");
		// The JSON of a document is never searchable (a Markdown drawing is a note, whose text is).
		assertThat(found("isDeleted")).containsExactly("Drawings/Shed.excalidraw.md");
		assertThat(found("notesapp")).isEmpty();

		assertThat(sources("Plumber.md")).containsExactlyInAnyOrder("Tasks/Home.tasks", "Drawings/House.excalidraw",
				"Drawings/Shed.excalidraw.md");
		assertThat(sources("Projects/Plan.md")).containsExactly("Tasks/Home.tasks");
		assertThat(sources("Painter.md")).containsExactly("Drawings/Shed.excalidraw.md");

		// The list and the JSON drawing are documents; the Markdown drawing is a note.
		assertThat(this.vault.index.stats().notes()).isEqualTo(4);
		for (String document : List.of("Tasks/Home.tasks", "Drawings/House.excalidraw")) {
			assertThatThrownBy(() -> this.notes.meta(document)).isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		}
		assertThat(this.notes.meta("Drawings/Shed.excalidraw.md")).isNotNull();
	}

	@Test
	void aRenameRewritesTheListAndTheMarkdownDrawingAndReportsTheJsonDrawing() throws IOException {
		MoveResult dryRun = this.vault.moves.move("Plumber.md", "Contacts/Plumber Bob.md", null, true,
				TestVault.ALICE, CLIENT);
		assertThat(dryRun.linkUpdates()).extracting((u) -> u.path() + " " + u.links())
			.containsExactlyInAnyOrder("Tasks/Home.tasks 2", "Drawings/Shed.excalidraw.md 2");
		assertThat(dryRun.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Drawings/House.excalidraw " + FailedReason.NOT_REWRITABLE);
		assertThat(read("Tasks/Home.tasks")).isEqualTo(LIST);
		assertThat(read("Drawings/Shed.excalidraw.md")).isEqualTo(SHED);

		MoveResult moved = this.vault.moves.move("Plumber.md", "Contacts/Plumber Bob.md", null, false,
				TestVault.ALICE, CLIENT);
		assertThat(moved.linkUpdates()).extracting((u) -> u.path() + " " + u.links())
			.containsExactlyInAnyOrder("Tasks/Home.tasks 2", "Drawings/Shed.excalidraw.md 2");
		assertThat(moved.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Drawings/House.excalidraw " + FailedReason.NOT_REWRITABLE);

		// The list is rewritten by its indexer: titles and notes; its related note did not move.
		String list = read("Tasks/Home.tasks");
		assertThat(list).contains("Call [[Plumber Bob]] about the leak #home", "Ask the [[Plumber Bob]] which one",
				"\"Projects/Plan.md\"");
		assertThat(list).doesNotContain("[[Plumber]]");
		// The Markdown drawing is spliced like a note: its sections, which the drawing view reads; the JSON stays.
		assertThat(read("Drawings/Shed.excalidraw.md"))
			.isEqualTo(SHED.replace("Fix the shed with [[Plumber]] ^Ab12Cd34", "Fix the shed with [[Plumber Bob]] ^Ab12Cd34")
				.replace("Rr11Ss22: [[Plumber]]", "Rr11Ss22: [[Plumber Bob]]"));
		// The JSON drawing is left as it is.
		assertThat(read("Drawings/House.excalidraw")).isEqualTo(HOUSE);

		assertThat(sources("Contacts/Plumber Bob.md")).containsExactlyInAnyOrder("Tasks/Home.tasks",
				"Drawings/Shed.excalidraw.md");
		assertThat(found("leak")).containsExactly("Tasks/Home.tasks");
		assertThat(found("shed")).containsExactly("Drawings/Shed.excalidraw.md");
	}

	@Test
	void eachIndexerKeepsToItsOwnFiles() throws IOException {
		// A list renamed to a drawing's name is read again from disk, by the drawing indexer, which cannot read it:
		// listed, not content-indexed.
		this.vault.moves.move("Tasks/Home.tasks", "Tasks/Home.excalidraw", null, false, TestVault.ALICE, CLIENT);
		assertThat(this.vault.index.file("Tasks/Home.excalidraw")).isNotNull();
		assertThat(found("leak")).isEmpty();
		assertThat(sources("Projects/Plan.md")).isEmpty();
		// And back: a list again.
		this.vault.moves.move("Tasks/Home.excalidraw", "Tasks/Home.tasks", null, false, TestVault.ALICE, CLIENT);
		assertThat(found("leak")).containsExactly("Tasks/Home.tasks");
		assertThat(sources("Projects/Plan.md")).containsExactly("Tasks/Home.tasks");
	}

	@Test
	void aHeadingRenameRewritesTheListAndTheMarkdownDrawingAndReportsWhatOnlyJsonHolds() throws IOException {
		String list = """
				{"type": "notesapp-tasks", "version": 1, "list": {"id": "WORK", "name": "Work", "order": "b0"},
				 "tasks": [{"id": "W1", "title": "Read [[Plan#Goals]]", "notes": "See [the goals](/Projects/Plan.md#Goals)"}]}
				""";
		String board = HOUSE.replace("Ask [[Plumber]] about the roof #home", "Discuss [[Plan#Goals]]");
		String wall = SHED.replace("Fix the shed with [[Plumber]] ^Ab12Cd34", "Pin [[Plan#Goals]] ^Ab12Cd34")
			.replace("\"rawText\": \"Fix the shed with [[Plumber]]\"", "\"rawText\": \"Pin [[Plan#Goals]]\"")
			.replace("Paint the shed with [[Painter]] #shed", "Also [[Plan#Goals]]");
		this.vault.files.createText("Tasks/Work.tasks", list, OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.files.createText("Drawings/Board.excalidraw", board, OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.files.createText("Drawings/Wall.excalidraw.md", wall, OnConflict.FAIL, TestVault.ALICE, CLIENT);
		String version = this.vault.index.file("Projects/Plan.md").version();
		this.vault.files.saveText("Projects/Plan.md", "# Plan\n\n## Aims\n", version, false, TestVault.ALICE, CLIENT);

		HeadingRenameResult dryRun = this.vault.headings.rename("Projects/Plan.md", "Goals", "Aims", true,
				TestVault.ALICE, CLIENT);
		HeadingRenameResult renamed = this.vault.headings.rename("Projects/Plan.md", "Goals", "Aims", false,
				TestVault.ALICE, CLIENT);
		for (HeadingRenameResult result : List.of(dryRun, renamed)) {
			assertThat(result.linkUpdates()).extracting((u) -> u.path() + " " + u.links())
				.containsExactlyInAnyOrder("Tasks/Work.tasks 2", "Drawings/Wall.excalidraw.md 1");
			assertThat(result.failed()).extracting((f) -> f.path() + " " + f.reason())
				.containsExactlyInAnyOrder("Drawings/Board.excalidraw " + FailedReason.NOT_REWRITABLE,
						"Drawings/Wall.excalidraw.md " + FailedReason.NOT_REWRITABLE);
		}
		// The list is rewritten through its indexer: still a valid list, its task updated.
		String rewritten = read("Tasks/Work.tasks");
		assertThat(rewritten).contains("Read [[Plan#Aims]]", "(/Projects/Plan.md#Aims)", "\"updatedAt\"")
			.doesNotContain("Goals");
		assertThat(found("Read")).contains("Tasks/Work.tasks");
		// The Markdown drawing's sections are spliced like a note's; its JSON, and the JSON drawing, stay.
		assertThat(read("Drawings/Wall.excalidraw.md")).isEqualTo(wall.replace("Pin [[Plan#Goals]] ^Ab12Cd34",
				"Pin [[Plan#Aims]] ^Ab12Cd34"));
		assertThat(read("Drawings/Board.excalidraw")).isEqualTo(board);
	}

}
