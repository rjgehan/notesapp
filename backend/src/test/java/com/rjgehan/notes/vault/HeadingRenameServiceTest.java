package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FailedUpdate;
import com.rjgehan.notes.api.dto.HeadingRenameResult;
import com.rjgehan.notes.api.dto.LinkUpdate;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.HistoryCommittedEvent;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.node.ArrayNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Updating {@code [[Note#Heading]]} links after a heading is renamed (ROADMAP item 21, DESIGN §5.22). */
class HeadingRenameServiceTest {

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
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private String read(String path) throws IOException {
		return Files.readString(this.dir.resolve(path), StandardCharsets.UTF_8);
	}

	private TestVault start() throws IOException {
		this.vault = TestVault.start(this.dir);
		return this.vault;
	}

	private HeadingRenameResult rename(String path, String from, String to, boolean dryRun) throws IOException {
		return this.vault.headings.rename(path, from, to, dryRun, TestVault.ALICE, CLIENT);
	}

	@Test
	void everyLinkFormToTheHeadingIsUpdatedAndNothingElse() throws Exception {
		write("Plan.md", "# Plan\n\n## Next  Steps\n\nSee [[#next steps]] and [[#Other]].\n");
		write("Notes.md", """
				[[Plan#Old goals]] [[Plan#old  goals|the goals]] ![[Plan#Old goals]] [[Plan#Plan#Old goals]]
				[x](Plan.md#Old%20goals) [y](<Plan.md#Old goals>) [z](Plan.md#Old%20goals "title")
				[[Other#Old goals]] [[Plan#Old goalsx]] [[Plan]] `[[Plan#Old goals]]`
				""");
		write("Other.md", "## Old goals\n");
		start();
		// The note was saved with its heading renamed (Old goals → Next  Steps) before the request.
		HeadingRenameResult preview = rename("Plan.md", "Old goals", "Next Steps", true);
		assertThat(preview.linkUpdates()).containsExactly(new LinkUpdate("Notes.md", 7, null));
		assertThat(read("Notes.md")).contains("[[Plan#Old goals]]");

		HeadingRenameResult result = rename("Plan.md", "Old goals", "Next Steps", false);
		assertThat(result.dryRun()).isFalse();
		assertThat(result.linkUpdates()).singleElement().satisfies((u) -> {
			assertThat(u.path()).isEqualTo("Notes.md");
			assertThat(u.links()).isEqualTo(7);
			assertThat(u.version()).isNotNull();
		});
		assertThat(read("Notes.md")).isEqualTo("""
				[[Plan#Next Steps]] [[Plan#Next Steps|the goals]] ![[Plan#Next Steps]] [[Plan#Plan#Next Steps]]
				[x](Plan.md#Next%20Steps) [y](<Plan.md#Next Steps>) [z](Plan.md#Next%20Steps "title")
				[[Other#Old goals]] [[Plan#Old goalsx]] [[Plan]] `[[Plan#Old goals]]`
				""");
		assertThat(read("Plan.md")).contains("[[#next steps]]");
		assertThat(this.vault.hub.published).filteredOn(FileEvent.class::isInstance)
			.extracting((e) -> ((FileEvent) e).file().path())
			.containsExactly("Notes.md");
		HistoryCommittedEvent commit = this.vault.hub.published.stream()
			.filter(HistoryCommittedEvent.class::isInstance)
			.map(HistoryCommittedEvent.class::cast)
			.reduce((a, b) -> b)
			.orElseThrow();
		assertThat(commit.message()).isEqualTo("Update links after renaming heading “Old goals” → “Next Steps” in Plan.md (1 note)");
		assertThat(commit.paths()).containsExactly("Notes.md");
		assertThat(result.commitId()).isEqualTo(commit.commitId());
	}

	@Test
	void sameNoteLinksAndFrontmatterLinksAreUpdated() throws Exception {
		write("Plan.md", """
				---
				related: "[[Plan#Old]]"
				---
				# New

				Back to [[#Old]] or [[Plan#Old]].
				""");
		start();
		HeadingRenameResult result = rename("Plan.md", "Old", "New", false);
		assertThat(result.linkUpdates()).extracting(LinkUpdate::path, LinkUpdate::links).containsExactly(
				org.assertj.core.groups.Tuple.tuple("Plan.md", 3));
		assertThat(read("Plan.md")).isEqualTo("""
				---
				related: "[[Plan#New]]"
				---
				# New

				Back to [[#New]] or [[Plan#New]].
				""");
	}

	@Test
	void aHeadingTheLinkSyntaxCannotHoldIsReportedNotWritten() throws Exception {
		write("Plan.md", "# C# tips\n");
		write("Notes.md", "[[Plan#Old]] and [m](Plan.md#Old)\n");
		start();
		HeadingRenameResult result = rename("Plan.md", "Old", "C# tips", false);
		assertThat(result.failed()).containsExactly(new FailedUpdate("Notes.md", FailedReason.NOT_REWRITABLE));
		assertThat(result.linkUpdates()).extracting(LinkUpdate::links).containsExactly(1);
		assertThat(read("Notes.md")).isEqualTo("[[Plan#Old]] and [m](Plan.md#C%23%20tips)\n");
	}

	@Test
	void theNoteMustHaveTheNewHeadingAndNoLongerTheOldOne() throws Exception {
		write("Plan.md", "# Old\n# New\n");
		write("Image.png", "x");
		start();
		assertThatThrownBy(() -> rename("Plan.md", "Old", "New", false)).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
		assertThatThrownBy(() -> rename("Plan.md", "Gone", "Missing", false))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
		assertThatThrownBy(() -> rename("Plan.md", "New", " new ", false))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
		assertThatThrownBy(() -> rename("Plan.md", "a\nb", "New", false))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
		assertThatThrownBy(() -> rename("Image.png", "Old", "New", false))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		assertThatThrownBy(() -> rename("Nope.md", "Old", "New", false))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
	}

	@Test
	void anExternalEditNotYetSeenIsKeptAndALossyNoteIsSkipped() throws Exception {
		write("Plan.md", "# New\n");
		write("Notes.md", "[[Plan#Old]]\n");
		Files.write(this.dir.resolve("Broken.md"), new byte[] { '[', '[', 'P', 'l', 'a', 'n', '#', 'O', 'l', 'd', ']', ']', ' ',
				(byte) 0xff, '\n' });
		start();
		write("Notes.md", "Edited elsewhere. [[Plan#Old]]\n");
		HeadingRenameResult result = rename("Plan.md", "Old", "New", false);
		assertThat(read("Notes.md")).isEqualTo("Edited elsewhere. [[Plan#New]]\n");
		assertThat(result.failed()).containsExactly(new FailedUpdate("Broken.md", FailedReason.NOT_UTF8));
	}

	@Test
	void headingBookmarksFollowTheRename() throws Exception {
		write("Plan.md", "# New\n");
		start();
		ArrayNode items = (ArrayNode) TestVault.JSON.readTree("""
				[{"type":"file","ctime":1,"path":"plan.md","subpath":"#old"},
				 {"type":"file","ctime":2,"path":"Plan.md","subpath":"#Other"},
				 {"type":"file","ctime":3,"path":"Plan.md"}]""");
		this.vault.bookmarks.update(items, this.vault.bookmarks.get().version(), TestVault.ALICE, CLIENT);
		assertThat(rename("Plan.md", "Old", "New", true).bookmarks()).isEqualTo(1);
		assertThat(this.vault.bookmarks.get().items().get(0).get("subpath").asString()).isEqualTo("#old");
		HeadingRenameResult result = rename("Plan.md", "Old", "New", false);
		assertThat(result.bookmarks()).isEqualTo(1);
		List<String> subpaths = this.vault.bookmarks.get()
			.items()
			.stream()
			.map((item) -> item.path("subpath").asString(""))
			.toList();
		assertThat(subpaths).containsExactly("#New", "#Other", "");
		assertThat(this.vault.hub.names()).contains("bookmarks.changed");
	}

	@Test
	void subpathSpansCoverWikiAndMarkdownForms() {
		String text = "[[A#B|c]] ![[A#B]] [[A#B\\|c]] [x](A.md#B%20c) [y](<A.md#B c>)";
		var links = com.rjgehan.notes.index.MarkdownScanner.scan(text, false, false).links();
		assertThat(links).hasSize(5);
		assertThat(links.stream().map((occ) -> {
			int[] span = HeadingRenameService.subpathSpan(text, occ);
			return text.substring(span[0], span[1]);
		})).containsExactly("B", "B", "B", "B%20c", "B c");
	}

}
