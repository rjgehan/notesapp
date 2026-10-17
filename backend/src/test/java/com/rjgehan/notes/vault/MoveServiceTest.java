package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import com.rjgehan.notes.api.dto.ChangeType;
import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.MovedFile;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.MovedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Move and rename with link rewriting (DESIGN §5.6). */
class MoveServiceTest {

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

	private void write(String path, String content) throws IOException {
		write(path, content.getBytes(StandardCharsets.UTF_8));
	}

	private void write(String path, byte[] bytes) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.write(file, bytes);
	}

	private String read(String path) throws IOException {
		return Files.readString(this.dir.resolve(path), StandardCharsets.UTF_8);
	}

	private TestVault start() throws IOException {
		this.vault = TestVault.start(this.dir);
		return this.vault;
	}

	private void commitAll() throws Exception {
		this.vault.git.commitAll((changes) -> new GitStore.Message("Initial commit", null), Author.EXTERNAL);
	}

	private MoveResult move(String from, String to) throws IOException {
		return this.vault.moves.move(from, to, null, false, TestVault.ALICE, CLIENT);
	}

	@Test
	void everyLinkFormIsRewrittenAndCodeIsLeftAlone() throws Exception {
		write("Plan.md", "# Plan\n");
		write("Source.md", """
				---
				related: "[[Plan]]"
				---
				[[Plan]] [[Plan|alias]] [[Plan#sub]] [[Plan#sub|alias]]
				![[Plan]] ![[Plan|300]]
				[text](Plan.md) [text](Plan.md#sub) [text](<Plan.md>) [text](Plan.md "title")
				`[[Plan]]` and [[Other]]
				```
				[[Plan]]
				```
				""");
		start();
		MoveResult result = move("Plan.md", "Roadmap.md");
		assertThat(read("Source.md")).isEqualTo("""
				---
				related: "[[Roadmap]]"
				---
				[[Roadmap]] [[Roadmap|alias]] [[Roadmap#sub]] [[Roadmap#sub|alias]]
				![[Roadmap]] ![[Roadmap|300]]
				[text](Roadmap.md) [text](Roadmap.md#sub) [text](<Roadmap.md>) [text](Roadmap.md "title")
				`[[Plan]]` and [[Other]]
				```
				[[Plan]]
				```
				""");
		assertThat(result.type()).isEqualTo(EntryType.FILE);
		assertThat(result.moved()).containsExactly(new MovedFile("Plan.md", "Roadmap.md"));
		assertThat(result.linkUpdates()).singleElement().satisfies((update) -> {
			assertThat(update.path()).isEqualTo("Source.md");
			assertThat(update.links()).isEqualTo(11);
			assertThat(update.version()).isEqualTo(Hashing.blobId(Files.readAllBytes(this.dir.resolve("Source.md"))));
		});
		assertThat(result.failed()).isEmpty();
		assertThat(this.vault.index.backlinkSources("Roadmap.md")).containsExactly("Source.md");
		assertThat(this.vault.index.file("Plan.md")).isNull();
	}

	@Test
	void imagesKeepTheirMarkdownStyle() throws Exception {
		write("img.png", new byte[] { 1, 2, 3 });
		write("Note.md", "![alt](img.png) and ![[img.png|300]]\n");
		start();
		move("img.png", "pics/photo.png");
		assertThat(read("Note.md")).isEqualTo("![alt](photo.png) and ![[photo.png|300]]\n");
	}

	@Test
	void relativeLinksInsideTheMovedNoteAreFixed() throws Exception {
		write("Projects/Plan.md", "# Plan\n");
		write("Projects/Alpha/notes.md", "notes\n");
		write("Projects/Alpha/Spec.md", "See [[./notes]] and [[../Plan]].\n");
		start();
		MoveResult result = move("Projects/Alpha/Spec.md", "Archive/Spec.md");
		assertThat(read("Archive/Spec.md")).isEqualTo("See [[notes]] and [[Plan]].\n");
		assertThat(result.createdFolders()).containsExactly("Archive");
		assertThat(result.linkUpdates()).singleElement()
			.satisfies((update) -> assertThat(update.path()).isEqualTo("Archive/Spec.md"));
		assertThat(this.vault.index.backlinkSources("Projects/Alpha/notes.md")).containsExactly("Archive/Spec.md");
	}

	@Test
	void collateralProtectionKeepsOtherLinksOnTheirTarget() throws Exception {
		write("Other/A.md", "other\n");
		write("Deep/Deeper/A.md", "deep\n");
		write("Note.md", "[[A]]\n");
		start();
		assertThat(this.vault.index.resolveLink("A", "Note.md")).isEqualTo("Other/A.md");
		move("Deep/Deeper/A.md", "A.md");
		assertThat(read("Note.md")).isEqualTo("[[Other/A]]\n");
		assertThat(this.vault.index.resolveLink("Other/A", "Note.md")).isEqualTo("Other/A.md");
	}

	@Test
	void folderMovesCarryEveryDescendant() throws Exception {
		write("Projects/Plan.md", "[[./Sub/Deep]]\n");
		write("Projects/Sub/Deep.md", "deep\n");
		write("Projects/pic.png", new byte[] { 9 });
		write("Index.md", "[[Projects/Plan]] [[Projects/Sub/Deep|deep]]\n");
		start();
		MoveResult result = move("Projects", "Archive/Projects");
		assertThat(result.type()).isEqualTo(EntryType.FOLDER);
		assertThat(result.moved()).extracting(MovedFile::to)
			.containsExactlyInAnyOrder("Archive/Projects/Plan.md", "Archive/Projects/Sub/Deep.md",
					"Archive/Projects/pic.png");
		assertThat(result.createdFolders()).containsExactly("Archive");
		assertThat(this.dir.resolve("Projects")).doesNotExist();
		assertThat(this.vault.index.isFolder("Archive/Projects/Sub")).isTrue();
		assertThat(this.vault.index.isFolder("Projects")).isFalse();
		assertThat(read("Index.md")).isEqualTo("[[Plan]] [[Deep|deep]]\n");
		assertThat(this.vault.index.resolveLink("./Sub/Deep", "Archive/Projects/Plan.md"))
			.isEqualTo("Archive/Projects/Sub/Deep.md");
		assertThat(read("Archive/Projects/Plan.md")).isEqualTo("[[./Sub/Deep]]\n");
		MovedEvent event = (MovedEvent) this.vault.hub.published.stream()
			.filter(MovedEvent.class::isInstance)
			.findFirst()
			.orElseThrow();
		assertThat(event.type()).isEqualTo(EntryType.FOLDER);
		assertThat(event.from()).isEqualTo("Projects");
	}

	@Test
	void anEmptyFolderMovesWithoutACommit() throws Exception {
		Files.createDirectories(this.dir.resolve("Empty"));
		start();
		commitAll();
		MoveResult result = move("Empty", "Still empty");
		assertThat(result.moved()).isEmpty();
		assertThat(result.commitId()).isNull();
		assertThat(this.vault.index.isFolder("Still empty")).isTrue();
		assertThat(this.vault.hub.names()).containsExactly("entry.moved");
	}

	@Test
	void dryRunChangesNothing() throws Exception {
		write("Plan.md", "# Plan\n");
		write("Source.md", "[[Plan]]\n");
		start();
		long generation = this.vault.index.generation();
		MoveResult result = this.vault.moves.move("Plan.md", "Roadmap.md", null, true, TestVault.ALICE, CLIENT);
		assertThat(result.dryRun()).isTrue();
		assertThat(result.linkUpdates()).singleElement().satisfies((update) -> {
			assertThat(update.path()).isEqualTo("Source.md");
			assertThat(update.version()).isNull();
		});
		assertThat(result.commitId()).isNull();
		assertThat(result.createdFolders()).isEmpty();
		assertThat(read("Source.md")).isEqualTo("[[Plan]]\n");
		assertThat(this.dir.resolve("Plan.md")).exists();
		assertThat(this.dir.resolve("Roadmap.md")).doesNotExist();
		assertThat(this.vault.index.generation()).isEqualTo(generation);
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void caseOnlyRenameIsAllowed() throws Exception {
		write("plan.md", "# plan\n");
		write("Source.md", "[[plan]]\n");
		start();
		move("plan.md", "Plan.md");
		try (Stream<Path> listing = Files.list(this.dir)) {
			assertThat(listing.map((p) -> p.getFileName().toString())).contains("Plan.md").doesNotContain("plan.md");
		}
		assertThat(this.vault.index.file("Plan.md")).isNotNull();
		assertThat(this.vault.index.file("plan.md")).isNull();
		assertThat(read("Source.md")).isEqualTo("[[Plan]]\n");
	}

	@Test
	void collisionsAndInvalidTargetsAreRefused() throws Exception {
		write("A/B/x.md", "x\n");
		write("Target.md", "t\n");
		write("Existing.md", "e\n");
		write("file.md", "f\n");
		start();
		assertThatThrownBy(() -> move("A", "A/B/A")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.MOVE_INTO_SELF));
		assertThatThrownBy(() -> move("A", "A")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.MOVE_INTO_SELF));
		assertThatThrownBy(() -> move("Target.md", "Existing.md")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.ALREADY_EXISTS));
		assertThatThrownBy(() -> move("Target.md", "existing.MD")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.CASE_COLLISION));
		assertThatThrownBy(() -> move("Target.md", "file.md/x.md")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		assertThatThrownBy(() -> move("Missing.md", "Other.md")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
		assertThatThrownBy(() -> move("Target.md", "Bad#name.md")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.INVALID_NAME));
		assertThat(this.dir.resolve("Target.md")).exists();
	}

	@Test
	void twoCommitsAndHistoryFollowsTheMovedNote() throws Exception {
		write("b.md", "b\n");
		write("a.md", "[[./b]]\n");
		start();
		commitAll();
		MoveResult result = move("a.md", "sub/a.md");
		assertThat(read("sub/a.md")).isEqualTo("[[b]]\n");
		List<HistoryEntry> entries = this.vault.history.list("sub/a.md", 10, 0).entries();
		assertThat(entries).extracting(HistoryEntry::message)
			.containsExactly("Update links after moving a.md → sub/a.md (1 note)", "Move a.md → sub/a.md",
					"Initial commit");
		assertThat(entries.get(1).change().name()).isEqualTo("RENAMED");
		assertThat(entries.get(1).renamedFrom()).isEqualTo("a.md");
		assertThat(entries.get(2).path()).isEqualTo("a.md");
		assertThat(result.commitId()).isEqualTo(entries.get(0).commitId());
		assertThat(this.vault.hub.names()).containsExactly("folder.created", "entry.moved", "file.changed",
				"history.committed", "history.committed");
	}

	@Test
	void renameWithinAFolderIsCommittedAsARename() throws Exception {
		write("Notes/Plan.md", "# Plan\n");
		start();
		commitAll();
		MoveResult result = move("Notes/Plan.md", "Notes/Roadmap.md");
		assertThat(result.linkUpdates()).isEmpty();
		assertThat(this.vault.history.list("Notes/Roadmap.md", 10, 0).entries().get(0).message())
			.isEqualTo("Rename Notes/Plan.md → Notes/Roadmap.md");
	}

	@Test
	void anUnreconciledExternalEditOfASourceNoteIsKept() throws Exception {
		write("Target.md", "t\n");
		write("Linker.md", "[[Target]]\n");
		start();
		write("Linker.md", "edited outside the app\n[[Target]]\n");
		MoveResult result = move("Target.md", "Renamed.md");
		assertThat(read("Linker.md")).isEqualTo("edited outside the app\n[[Renamed]]\n");
		assertThat(result.linkUpdates()).extracting((update) -> update.path()).containsExactly("Linker.md");
	}

	@Test
	void lossyNotesAreNeverRewritten() throws Exception {
		byte[] lossy = { '[', '[', 'T', 'a', 'r', 'g', 'e', 't', ']', ']', ' ', (byte) 0xC3, (byte) 0x28, '\n' };
		write("Target.md", "t\n");
		write("Broken.md", lossy);
		start();
		MoveResult result = move("Target.md", "Renamed.md");
		assertThat(Files.readAllBytes(this.dir.resolve("Broken.md"))).isEqualTo(lossy);
		assertThat(result.failed()).singleElement().satisfies((failed) -> {
			assertThat(failed.path()).isEqualTo("Broken.md");
			assertThat(failed.reason()).isEqualTo(FailedReason.NOT_UTF8);
		});
		assertThat(result.linkUpdates()).isEmpty();
	}

	@Test
	void nonRewritableFrontmatterLinksAreReported() throws Exception {
		write("Target.md", "t\n");
		write("Props.md", "---\nlink: \"[[Tar\\x67et]]\"\n---\n[[Target]]\n");
		start();
		MoveResult result = move("Target.md", "Renamed.md");
		assertThat(read("Props.md")).isEqualTo("---\nlink: \"[[Tar\\x67et]]\"\n---\n[[Renamed]]\n");
		assertThat(result.failed()).singleElement().satisfies((failed) -> {
			assertThat(failed.path()).isEqualTo("Props.md");
			assertThat(failed.reason()).isEqualTo(FailedReason.NOT_REWRITABLE);
		});
		assertThat(result.linkUpdates()).extracting((update) -> update.path()).containsExactly("Props.md");
	}

	@Test
	void frontmatterLinksAreRewrittenForTheirYamlQuoting() throws Exception {
		write("Target.md", "t\n");
		write("Linker.md", """
				---
				single: '[[Target]]'
				double: "[[Target]]"
				plain: see [[Target]]
				block: |
				  [[Target]]
				tags: [a]
				---
				[[Target]]
				""");
		start();
		MoveResult result = move("Target.md", "Bob's Target.md");
		assertThat(read("Linker.md")).isEqualTo("""
				---
				single: '[[Bob''s Target]]'
				double: "[[Bob's Target]]"
				plain: see [[Bob's Target]]
				block: |
				  [[Bob's Target]]
				tags: [a]
				---
				[[Bob's Target]]
				""");
		assertThat(result.failed()).isEmpty();
		assertThat(result.linkUpdates()).singleElement().satisfies((update) -> assertThat(update.links()).isEqualTo(5));
		assertThat(this.vault.index.note("Linker.md").parse().frontmatterError()).isNull();
		assertThat(this.vault.index.notesWithTag("a", false)).containsExactly("Linker.md");
		assertThat(this.vault.index.outgoingLinks("Linker.md")).extracting((resolved) -> resolved.target())
			.containsOnly("Bob's Target.md")
			.hasSize(5);
	}

	@Test
	void aRewriteThatWouldChangeTheFrontmatterIsRefused() {
		String before = "---\nrelated: '[[Target]]'\ntags: [a]\n---\n";
		assertThat(MoveService.frontmatterSurvives(before, "---\nrelated: '[[Bob''s Target]]'\ntags: [a]\n---\n"))
			.isTrue();
		assertThat(MoveService.frontmatterSurvives(before, "---\nrelated: '[[Bob's Target]]'\ntags: [a]\n---\n"))
			.isFalse();
		assertThat(MoveService.frontmatterSurvives("---\nx: see [[A]] now\n---\n", "---\nx: see [[A #b]] now\n---\n"))
			.isFalse();
		assertThat(MoveService.frontmatterSurvives("No frontmatter [[A]]\n", "No frontmatter [[B's]]\n")).isTrue();
	}

	@Test
	void aBomSurvivesARewrite() throws Exception {
		write("Target.md", "t\n");
		write("Bom.md", TextCodec.encode("[[Target]]\r\n", true));
		start();
		move("Target.md", "Renamed.md");
		assertThat(Files.readAllBytes(this.dir.resolve("Bom.md"))).isEqualTo(TextCodec.encode("[[Renamed]]\r\n", true));
	}

	@Test
	void aSaveToTheOldPathLearnsWhereTheNoteWent() throws Exception {
		write("Target.md", "t\n");
		start();
		String version = this.vault.index.file("Target.md").version();
		move("Target.md", "Moved/Target.md");
		assertThatThrownBy(() -> this.vault.files.saveText("Target.md", "mine", version, false, TestVault.BOB,
				"client-b1"))
			.isInstanceOfSatisfying(VersionConflictException.class,
					(ex) -> assertThat(ex.getBody().getProperties()).containsEntry("movedTo", "Moved/Target.md"));
	}

	@Test
	void aRenameThatChangesTheExtensionIndexesTheFileForItsNewKind() throws Exception {
		write("Target.md", "t\n");
		write("Draft.txt", "#drafttag and [[Target]]\n");
		start();
		move("Draft.txt", "Draft.md");
		assertThat(this.vault.index.file("Draft.md").kind()).isEqualTo(FileKind.NOTE);
		assertThat(this.vault.index.note("Draft.md")).isNotNull();
		assertThat(this.vault.index.backlinkSources("Target.md")).containsExactly("Draft.md");
		assertThat(this.vault.index.notesWithTag("drafttag", false)).containsExactly("Draft.md");
		assertThat(this.vault.index.resolveLink("Draft", "Target.md")).isEqualTo("Draft.md");

		move("Draft.md", "Draft.txt");
		assertThat(this.vault.index.file("Draft.txt").kind()).isEqualTo(FileKind.TEXT);
		assertThat(this.vault.index.note("Draft.txt")).isNull();
		assertThat(this.vault.index.backlinkSources("Target.md")).isEmpty();
		assertThat(this.vault.index.notesWithTag("drafttag", false)).isEmpty();
		assertThat(read("Draft.txt")).isEqualTo("#drafttag and [[Target]]\n");
	}

	@Test
	void anUnreconciledExternalEditOfTheMovedNoteIsCommittedBeforeThePureRename() throws Exception {
		write("Projects/Plan.md", "# Plan\nThe first version.\n");
		start();
		commitAll();
		write("Projects/Plan.md", "Rewritten outside the app\n");
		move("Projects/Plan.md", "Projects/Roadmap.md");
		List<HistoryEntry> entries = this.vault.history.list("Projects/Roadmap.md", 10, 0).entries();
		assertThat(entries).extracting(HistoryEntry::message)
			.containsExactly("Rename Projects/Plan.md → Projects/Roadmap.md", "External changes: 1 file",
					"Initial commit");
		assertThat(entries.get(0).change()).isEqualTo(ChangeType.RENAMED);
		assertThat(entries.get(1).authorName()).isEqualTo(Author.EXTERNAL.name());
		assertThat(entries.get(1).path()).isEqualTo("Projects/Plan.md");
	}

	@Test
	void unreconciledChangesInsideAMovedFolderAreCommittedBeforeTheRename() throws Exception {
		write("Projects/Plan.md", "# Plan\nThe first version.\n");
		write("Projects/Sub/Spec.md", "# Spec\n");
		start();
		commitAll();
		write("Projects/Sub/Spec.md", "Rewritten outside the app\n");
		write("Projects/New.md", "Created outside the app\n");
		MoveResult result = move("Projects", "Archive");
		assertThat(result.moved()).extracting(MovedFile::to)
			.containsExactlyInAnyOrder("Archive/Plan.md", "Archive/Sub/Spec.md", "Archive/New.md");
		List<HistoryEntry> spec = this.vault.history.list("Archive/Sub/Spec.md", 10, 0).entries();
		assertThat(spec).extracting(HistoryEntry::message)
			.containsExactly("Rename Projects → Archive", "External changes: 2 files", "Initial commit");
		assertThat(spec.get(0).change()).isEqualTo(ChangeType.RENAMED);
		assertThat(this.vault.history.list("Archive/New.md", 10, 0).entries()).extracting(HistoryEntry::message)
			.containsExactly("Rename Projects → Archive", "External changes: 2 files");
	}

	@Test
	void aCaseOnlyRenameStagesBesideTheEntryAndRollsBackWhenItsSecondStepFails() throws Exception {
		List<String> staged = new java.util.concurrent.CopyOnWriteArrayList<>();
		this.vault = TestVault.start(this.dir, java.util.Map.of(), (properties) -> new VaultFs(properties) {

			@Override
			public void moveExclusive(String fromDisk, String toDisk) throws IOException {
				if (PathNames.nameOf(fromDisk).startsWith(".notesapp-") && toDisk.equals("Notes/Plan.md")) {
					staged.add(fromDisk);
					throw new IOException("simulated: no space for the directory entry");
				}
				super.moveExclusive(fromDisk, toDisk);
			}

		});
		this.vault.files.createText("Notes/plan.md", "# plan\n", com.rjgehan.notes.api.dto.OnConflict.FAIL,
				TestVault.ALICE, CLIENT);
		assertThatThrownBy(() -> move("Notes/plan.md", "Notes/Plan.md")).isInstanceOf(IOException.class);
		assertThat(staged).singleElement()
			.satisfies((stage) -> assertThat(PathNames.parentOf(stage)).isEqualTo("Notes"));
		try (Stream<Path> listing = Files.list(this.dir.resolve("Notes"))) {
			assertThat(listing.map((p) -> p.getFileName().toString())).containsExactly("plan.md");
		}
		assertThat(read("Notes/plan.md")).isEqualTo("# plan\n");
		assertThat(this.vault.index.file("Notes/plan.md")).isNotNull();
		try (Stream<Path> temp = Files.list(this.dir.resolve(".notesapp/tmp"))) {
			assertThat(temp).isEmpty();
		}
	}

	@Test
	void updateLinksFalseOnlyMoves() throws Exception {
		write("Target.md", "t\n");
		write("Linker.md", "[[Target]]\n");
		start();
		MoveResult result = this.vault.moves.move("Target.md", "Renamed.md", false, false, TestVault.ALICE, CLIENT);
		assertThat(result.linkUpdates()).isEmpty();
		assertThat(read("Linker.md")).isEqualTo("[[Target]]\n");
		assertThat(this.vault.index.backlinkSources("Renamed.md")).isEmpty();
	}

}
