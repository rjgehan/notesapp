package com.rjgehan.notes.bookmarks;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import com.rjgehan.notes.api.dto.BookmarksResponse;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.RestoreRequest;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.BookmarksChangedEvent;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.Hashing;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Bookmarks: storage, validation, the version protocol, Obsidian's format and re-keying (DESIGN §5.21). */
class BookmarkServiceTest {

	private static final String CLIENT = "client-a1";

	@TempDir
	Path dir;

	private TestVault vault;

	@AfterEach
	void tearDown() {
		if (this.vault != null) {
			this.vault.close();
		}
	}

	private TestVault start() throws IOException {
		this.vault = TestVault.start(this.dir);
		return this.vault;
	}

	private void write(String path, String content) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private BookmarkService service() {
		return this.vault.bookmarks;
	}

	private static ArrayNode items(String json) {
		return (ArrayNode) TestVault.JSON.readTree(json);
	}

	private BookmarksResponse put(String json) throws IOException {
		return service().update(items(json), service().get().version(), TestVault.ALICE, CLIENT);
	}

	private List<String> paths(BookmarksResponse response) {
		return flatten(response.items()).stream().map((item) -> item.path("path").asString("")).toList();
	}

	private static List<JsonNode> flatten(List<? extends JsonNode> items) {
		return items.stream().flatMap((item) -> {
			JsonNode children = item.get("items");
			Stream<JsonNode> self = Stream.of(item);
			if (children == null || !children.isArray()) {
				return self;
			}
			return Stream.concat(self, flatten(children.values().stream().toList()).stream());
		}).toList();
	}

	private List<FieldError> errors(NotesException ex) {
		@SuppressWarnings("unchecked")
		List<FieldError> errors = (List<FieldError>) ex.getBody().getProperties().get("errors");
		return errors;
	}

	@Test
	void aVaultWithoutTheFileHasNoBookmarksAndAGetWritesNothing() throws Exception {
		start();
		BookmarksResponse empty = service().get();
		assertThat(empty.items()).isEmpty();
		assertThat(empty.version()).isEqualTo(Hashing.blobId("{\n  \"items\": []\n}\n".getBytes(StandardCharsets.UTF_8)));
		assertThat(this.dir.resolve(BookmarkService.FILE)).doesNotExist();
	}

	@Test
	void aSaveWritesObsidiansFormatBumpsTheVersionAndIsCommittedInTheBatch() throws Exception {
		start();
		write("Plan.md", "# Plan\n## Goals\n");
		String base = service().get().version();
		BookmarksResponse saved = service().update(items("""
				[{"type":"file","ctime":1760616202120,"path":"Plan.md","subpath":"#Goals","title":"Goals"},
				 {"type":"search","ctime":1760616202121,"query":"tag:#work"}]"""), base, TestVault.ALICE, CLIENT);
		Path file = this.dir.resolve(BookmarkService.FILE);
		assertThat(saved.version()).isNotEqualTo(base).isEqualTo(Hashing.blobId(Files.readAllBytes(file)));
		assertThat(Files.readString(file)).isEqualTo("""
				{
				  "items": [
				    {
				      "type": "file",
				      "ctime": 1760616202120,
				      "path": "Plan.md",
				      "subpath": "#Goals",
				      "title": "Goals"
				    },
				    {
				      "type": "search",
				      "ctime": 1760616202121,
				      "query": "tag:#work"
				    }
				  ]
				}
				""");
		assertThat(this.vault.hub.published).containsExactly(new BookmarksChangedEvent(saved.version(), CLIENT));
		assertThat(service().get()).isEqualTo(saved);
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.paths()).containsExactly(BookmarkService.FILE);
		assertThat(commit.author().email()).isEqualTo("alice@github");
	}

	@Test
	void savingTheSameBookmarksAgainChangesNothingWhateverTheBaseVersion() throws Exception {
		start();
		BookmarksResponse saved = put("[{\"type\":\"folder\",\"ctime\":1,\"path\":\"Projects\"}]");
		this.vault.hub.published.clear();
		BookmarksResponse again = service().update(items("[{\"type\":\"folder\",\"ctime\":1,\"path\":\"Projects\"}]"),
				"0000000000000000000000000000000000000000", TestVault.BOB, "client-b2");
		assertThat(again.version()).isEqualTo(saved.version());
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void aStaleSaveIsAConflictCarryingTheServerCopy() throws Exception {
		start();
		String base = service().get().version();
		BookmarksResponse saved = put("[{\"type\":\"search\",\"ctime\":1,\"query\":\"plans\"}]");
		assertThatThrownBy(() -> service().update(items("[]"), base, TestVault.BOB, "client-b2"))
			.isInstanceOfSatisfying(VersionConflictException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.VERSION_CONFLICT);
				assertThat(ex.getBody().getProperties()).containsEntry("currentVersion", saved.version())
					.containsEntry("path", BookmarkService.FILE);
				assertThat((String) ex.getBody().getProperties().get("currentContent")).contains("\"query\": \"plans\"");
			});
	}

	@Test
	void validationReportsEveryInvalidFieldByName() throws Exception {
		start();
		String base = service().get().version();
		ArrayNode body = items("""
				[{"ctime":1,"path":"A.md"},
				 {"type":"file","ctime":1},
				 {"type":"file","ctime":1,"path":"../up.md"},
				 {"type":"folder","ctime":1,"path":".git"},
				 {"type":"file","ctime":-5,"path":"A.md"},
				 {"type":"file","ctime":1,"path":"A.md","subpath":"Heading"},
				 {"type":"search","ctime":1,"query":"  "},
				 {"type":"group","ctime":1,"title":"G","items":[{"type":"search","ctime":1}]},
				 {"type":"group","ctime":1,"title":"No items"},
				 "text"]""");
		assertThatThrownBy(() -> service().update(body, base, TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST);
				assertThat(errors(ex)).extracting(FieldError::field)
					.containsExactly("items[0].type", "items[1].path", "items[2].path", "items[3].path",
							"items[4].ctime", "items[5].subpath", "items[6].query", "items[7].items[0].query",
							"items[8].items", "items[9]");
			});
		assertThatThrownBy(() -> service().update(items("[]"), null, TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(errors(ex)).extracting(FieldError::field)
				.containsExactly("baseVersion"));
		assertThatThrownBy(() -> service().update(null, base, TestVault.ALICE, CLIENT))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(errors(ex)).extracting(FieldError::field)
				.containsExactly("items"));
		assertThat(this.dir.resolve(BookmarkService.FILE)).doesNotExist();
	}

	@Test
	void unknownTypesAndFieldsSurviveAndPathsAreNormalized() throws Exception {
		start();
		write(BookmarkService.FILE, """
				{
				  "items": [
				    {"type": "url", "ctime": 3, "url": "https://example.com", "title": "Example"},
				    {"type": "graph", "ctime": 4, "options": {"depth": 2}}
				  ],
				  "futureField": true
				}
				""");
		BookmarksResponse current = service().get();
		assertThat(current.items()).hasSize(2);
		ArrayNode next = TestVault.JSON.valueToTree(current.items());
		ObjectNode note = next.addObject();
		note.put("type", "file").put("ctime", 5).put("path", "Café.md").put("color", "red");
		BookmarksResponse saved = service().update(next, current.version(), TestVault.ALICE, CLIENT);
		assertThat(saved.items().get(2).get("path").asString()).isEqualTo("Café.md");
		String text = Files.readString(this.dir.resolve(BookmarkService.FILE));
		assertThat(text).contains("\"futureField\": true", "\"url\": \"https://example.com\"", "\"depth\": 2",
				"\"color\": \"red\"", "Café.md");
	}

	@Test
	void invalidBookmarksInTheFileAreLeftOutAndABrokenFileIsKeptBeforeItIsReplaced() throws Exception {
		start();
		write(BookmarkService.FILE, """
				{"items": [{"type": "file", "ctime": 1}, {"type": "folder", "ctime": 2, "path": "Kept"},
				  {"type": "group", "ctime": 3, "title": "G", "items": [{"type": "file", "path": ".obsidian/x"},
				    {"type": "search", "query": "x"}]}]}""");
		assertThat(paths(service().get())).containsExactly("Kept", "", "");
		assertThat(flatten(service().get().items())).hasSize(3);

		write(BookmarkService.FILE, "{ not json");
		BookmarksResponse broken = service().get();
		assertThat(broken.items()).isEmpty();
		service().update(items("[{\"type\":\"search\",\"ctime\":1,\"query\":\"x\"}]"), broken.version(),
				TestVault.ALICE, CLIENT);
		try (Stream<Path> files = Files.list(this.dir.resolve(".notesapp"))) {
			Path backup = files.filter((p) -> p.getFileName().toString().startsWith("bookmarks.json.bak-"))
				.findFirst()
				.orElseThrow();
			assertThat(Files.readString(backup)).isEqualTo("{ not json");
		}
	}

	@Test
	void obsidiansBookmarksShowUntilTheFirstChangeAndAreNeverWritten() throws Exception {
		start();
		String obsidian = """
				{
				  "items": [
				    {"type": "file", "ctime": 1675091840117, "path": "Untitled.md", "subpath": "#Heading 1"},
				    {"type": "group", "ctime": 2, "title": "Reading", "items": [{"type": "folder", "ctime": 3, "path": "Books"}]}
				  ]
				}
				""";
		write(".obsidian/bookmarks.json", obsidian);
		BookmarksResponse seeded = service().get();
		assertThat(paths(seeded)).containsExactly("Untitled.md", "", "Books");
		assertThat(this.dir.resolve(BookmarkService.FILE)).doesNotExist();

		ArrayNode next = TestVault.JSON.valueToTree(seeded.items());
		next.remove(0);
		service().update(next, seeded.version(), TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("", "Books");
		assertThat(Files.readString(this.dir.resolve(".obsidian/bookmarks.json"))).isEqualTo(obsidian);
	}

	@Test
	void bookmarksFollowAFileMoveAndEveryClientHearsOfIt() throws Exception {
		start();
		write("Plan.md", "# Plan\n");
		write("Other.md", "x\n");
		this.vault.builder.build();
		put("""
				[{"type":"file","ctime":1,"path":"plan.md","subpath":"#Goals"},
				 {"type":"file","ctime":2,"path":"Other.md"},
				 {"type":"group","ctime":3,"title":"G","items":[{"type":"file","ctime":4,"path":"Plan.md"}]}]""");
		this.vault.hub.published.clear();
		this.vault.moves.move("Plan.md", "Archive/Roadmap.md", null, false, TestVault.ALICE, CLIENT);
		BookmarksResponse after = service().get();
		assertThat(paths(after)).containsExactly("Archive/Roadmap.md", "Other.md", "", "Archive/Roadmap.md");
		assertThat(after.items().get(0).get("subpath").asString()).isEqualTo("#Goals");
		assertThat(this.vault.hub.published).contains(new BookmarksChangedEvent(after.version(), null));
		assertThat(this.vault.hub.names()).containsSubsequence("entry.moved", "bookmarks.changed", "history.committed");
		assertThat(this.vault.flush().paths()).contains(BookmarkService.FILE);
	}

	@Test
	void aMoveThatTouchesNoBookmarkWritesNothing() throws Exception {
		start();
		write("Plan.md", "# Plan\n");
		write("Other.md", "x\n");
		this.vault.builder.build();
		BookmarksResponse saved = put("[{\"type\":\"file\",\"ctime\":2,\"path\":\"Other.md\"}]");
		this.vault.hub.published.clear();
		this.vault.moves.move("Plan.md", "Plan 2.md", null, false, TestVault.ALICE, CLIENT);
		assertThat(service().get().version()).isEqualTo(saved.version());
		assertThat(this.vault.hub.names()).doesNotContain("bookmarks.changed");
	}

	@Test
	void bookmarksUnderAMovedFolderFollowIt() throws Exception {
		start();
		write("Projects/Plan.md", "# Plan\n");
		write("Projects/Deep/Note.md", "x\n");
		write("Projects-old/Keep.md", "x\n");
		this.vault.builder.build();
		put("""
				[{"type":"folder","ctime":1,"path":"Projects"},
				 {"type":"file","ctime":2,"path":"projects/Deep/Note.md"},
				 {"type":"folder","ctime":3,"path":"Projects/Deep"},
				 {"type":"file","ctime":4,"path":"Projects/Gone.md"},
				 {"type":"file","ctime":5,"path":"Projects-old/Keep.md"}]""");
		this.vault.moves.move("Projects", "Work/Projects", null, false, TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Work/Projects", "Work/Projects/Deep/Note.md",
				"Work/Projects/Deep", "Work/Projects/Gone.md", "Projects-old/Keep.md");
	}

	@Test
	void aBookmarkOfACaseVariantThatStillExistsIsNotTaken() throws Exception {
		start();
		write("Plan.md", "# Plan\n");
		write("Sub/plan.md", "x\n");
		this.vault.builder.build();
		put("[{\"type\":\"file\",\"ctime\":1,\"path\":\"Sub/plan.md\"},{\"type\":\"file\",\"ctime\":2,\"path\":\"Plan.md\"}]");
		this.vault.moves.move("Sub/plan.md", "Sub/plan2.md", null, false, TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Sub/plan2.md", "Plan.md");
	}

	@Test
	void aDeletedTargetKeepsItsBookmarkAndARestoreElsewhereBringsItAlong() throws Exception {
		start();
		write("Plan.md", "# Plan\n");
		write("Folder/A.md", "a\n");
		this.vault.builder.build();
		put("[{\"type\":\"file\",\"ctime\":1,\"path\":\"Plan.md\"},{\"type\":\"file\",\"ctime\":2,\"path\":\"Folder/A.md\"}]");
		TrashEntry note = this.vault.trash.deleteFile("Plan.md", TestVault.ALICE, CLIENT);
		TrashEntry folder = this.vault.trash.deleteFolder("Folder", TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Plan.md", "Folder/A.md");

		this.vault.trash.restore(note.id(), new RestoreRequest("Archive/Plan.md", null), TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Archive/Plan.md", "Folder/A.md");
		this.vault.trash.restore(folder.id(), null, TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Archive/Plan.md", "Folder/A.md");
	}

	@Test
	void aRestoreUnderANewNameLeavesABookmarkWhosePathWasTakenAlone() throws Exception {
		start();
		write("Plan.md", "# Plan\n");
		this.vault.builder.build();
		put("[{\"type\":\"file\",\"ctime\":1,\"path\":\"Plan.md\"}]");
		TrashEntry note = this.vault.trash.deleteFile("Plan.md", TestVault.ALICE, CLIENT);
		this.vault.files.createText("Plan.md", "new\n", OnConflict.FAIL, TestVault.ALICE, CLIENT);
		this.vault.trash.restore(note.id(), new RestoreRequest(null, OnConflict.RENAME), TestVault.ALICE, CLIENT);
		assertThat(paths(service().get())).containsExactly("Plan.md");
	}

	@Test
	void belowCountsSegmentsNotCharacters() {
		assertThat(BookmarkService.below("Projects/Deep/Note.md", "projects")).isEqualTo("Deep/Note.md");
		assertThat(BookmarkService.below("A/B/C", "a/b")).isEqualTo("C");
	}

}
