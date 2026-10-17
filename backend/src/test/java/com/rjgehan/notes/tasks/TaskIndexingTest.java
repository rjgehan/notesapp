package com.rjgehan.notes.tasks;

import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.BacklinkGroup;
import com.rjgehan.notes.api.dto.BacklinksResponse;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.SearchResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.index.NoteService;
import com.rjgehan.notes.index.SearchService;
import com.rjgehan.notes.index.TagIndex;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static com.rjgehan.notes.tasks.TaskServiceTest.codeOf;
import static org.assertj.core.api.Assertions.assertThat;

/** {@code [[Note]]} links and {@code #tags} in tasks feed backlinks, tags and search (the DocumentIndexer). */
class TaskIndexingTest {

	@TempDir
	Path dir;

	private TaskFixture fx;

	private NoteService notes;

	private SearchService search;

	@BeforeEach
	void setUp() throws Exception {
		this.fx = TaskFixture.start(this.dir);
		this.notes = new NoteService(this.fx.vault.paths, this.fx.vault.index, this.fx.vault.kinds,
				this.fx.vault.settings);
		this.search = new SearchService(this.fx.vault.index, this.fx.vault.settings);
		this.fx.vault.files.createText("Plumber.md", "# Plumber\n", OnConflict.FAIL, TestVault.ALICE, "c-notes-1");
		this.fx.vault.files.createText("Projects/Plan.md", "# Plan\n", OnConflict.FAIL, TestVault.ALICE, "c-notes-1");
		this.fx.vault.files.createText("Call.md", "Nothing\n", OnConflict.FAIL, TestVault.ALICE, "c-notes-1");
		this.fx.create("""
				{"title": "Call [[Plumber]] about the leak #home", "tags": ["errands"],
				 "links": ["Projects/Plan.md"], "notes": "```\\ncode that mentions [[Call]]"}
				""");
		this.fx.create("{\"title\": \"Then [[Call]] back\"}");
	}

	@AfterEach
	void tearDown() {
		this.fx.close();
	}

	@Test
	void linksInTitlesAndRelatedNotesAreBacklinks() {
		BacklinksResponse plumber = this.notes.backlinks("Plumber.md", false);
		assertThat(plumber.linked()).extracting(BacklinkGroup::source).containsExactly("Tasks/Inbox.tasks");
		assertThat(plumber.linked().get(0).mentions().get(0).context())
			.isEqualTo("Call [[Plumber]] about the leak #home");
		BacklinksResponse plan = this.notes.backlinks("Projects/Plan.md", false);
		assertThat(plan.linked()).extracting(BacklinkGroup::source).containsExactly("Tasks/Inbox.tasks");
		// A link inside a code fence does not count, and a fence left open in one task's notes does not hide the
		// next task.
		List<BacklinkGroup> call = this.notes.backlinks("Call.md", false).linked();
		assertThat(call).hasSize(1);
		assertThat(call.get(0).mentions()).extracting((m) -> m.context()).containsExactly("Then [[Call]] back");
	}

	@Test
	void tagsCountAndSearchFindsTasks() {
		List<String> tags = this.fx.vault.index.tagStats().stream().map(TagIndex.TagStat::tag).toList();
		assertThat(tags).contains("home", "errands");
		SearchResponse found = this.search.search("leak", 10, "relevance", true);
		assertThat(found.results()).extracting((hit) -> hit.path()).containsExactly("Tasks/Inbox.tasks");
		assertThat(this.search.search("tag:errands", 10, "relevance", false).total()).isEqualTo(1);
	}

	@Test
	void aTaskFileIsNotANote() {
		assertThat(codeOf(() -> this.notes.meta("Tasks/Inbox.tasks"))).isEqualTo(ErrorCode.TYPE_MISMATCH);
		assertThat(this.fx.vault.index.stats().notes()).isEqualTo(3);
		// "Call" is in the task's title, but a task file is never offered for unlinked mentions.
		assertThat(this.notes.backlinks("Call.md", true).unlinked()).isEmpty();
	}

	@Test
	void renamingALinkedNoteReportsTheTaskFileInsteadOfRewritingIt() throws Exception {
		String before = this.fx.read("Tasks/Inbox.tasks");
		MoveResult moved = this.fx.vault.moves.move("Plumber.md", "Contacts/Plumber Bob.md", null, false,
				TestVault.ALICE, "c-notes-1");
		assertThat(moved.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Tasks/Inbox.tasks " + FailedReason.NOT_REWRITABLE);
		assertThat(this.fx.read("Tasks/Inbox.tasks")).isEqualTo(before);
	}

	@Test
	void editsThroughTheTaskApiAreIndexed() throws Exception {
		String id = this.fx.tasks.query("search", null, null, null, null, "leak", null, null, null, null, null)
			.tasks()
			.get(0)
			.id();
		this.fx.patch(id, "{\"title\": \"Pay [[Plumber]]\", \"links\": []}", null);
		assertThat(this.notes.backlinks("Projects/Plan.md", false).linked()).isEmpty();
		assertThat(this.notes.backlinks("Plumber.md", false).linked().get(0).mentions().get(0).context())
			.isEqualTo("Pay [[Plumber]]");
	}

}
