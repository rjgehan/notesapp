package com.rjgehan.notes.tasks;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.CreateTaskListRequest;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.ReorderRequest;
import com.rjgehan.notes.api.dto.ReorderTasksRequest;
import com.rjgehan.notes.api.dto.SectionRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskListWriteResult;
import com.rjgehan.notes.api.dto.TaskSection;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static com.rjgehan.notes.tasks.TaskServiceTest.codeOf;
import static com.rjgehan.notes.tasks.TaskServiceTest.exception;
import static org.assertj.core.api.Assertions.assertThat;

class TaskListServiceTest {

	@TempDir
	Path dir;

	private TaskFixture fx;

	@BeforeEach
	void setUp() throws Exception {
		this.fx = TaskFixture.start(this.dir);
	}

	@AfterEach
	void tearDown() {
		this.fx.close();
	}

	private TaskListWriteResult update(String id, String changes, String base) throws Exception {
		return this.fx.lists.update(id,
				new UpdateTaskRequest(TaskFixture.json(changes), (base != null) ? TaskFixture.json(base) : null),
				TestVault.ALICE, TaskFixture.CLIENT);
	}

	@Test
	void aListIsAFileNamedAfterIt() throws Exception {
		TaskListWriteResult result = this.fx.lists.create(new CreateTaskListRequest("Q4: Plans/Ideas", "#ff8800",
				"lightbulb"), TestVault.ALICE, TaskFixture.CLIENT);
		TaskList list = result.lists().get(0);
		assertThat(list.name()).isEqualTo("Q4: Plans/Ideas");
		assertThat(list.path()).isEqualTo("Tasks/Q4- Plans-Ideas.tasks");
		assertThat(list.color()).isEqualTo("#ff8800");
		assertThat(list.icon()).isEqualTo("lightbulb");
		assertThat(list.order()).isEqualTo("a0");
		assertThat(result.createdFolders()).containsExactly("Tasks");
		// A second list of the same name gets its own file.
		TaskList twin = this.fx.createList("Q4: Plans/Ideas");
		assertThat(twin.path()).isEqualTo("Tasks/Q4- Plans-Ideas 1.tasks");
		assertThat(twin.order()).isEqualTo("a1");
		assertThat(codeOf(() -> this.fx.lists.create(new CreateTaskListRequest(" ", null, null), TestVault.ALICE,
				TaskFixture.CLIENT))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.lists.create(new CreateTaskListRequest("X", "url(evil)", null),
				TestVault.ALICE, TaskFixture.CLIENT))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.lists.create(new CreateTaskListRequest("X", null, "<svg>"), TestVault.ALICE,
				TaskFixture.CLIENT))).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void renamingAListRenamesItsFileAndLinksFollow() throws Exception {
		TaskList list = this.fx.createList("Home");
		this.fx.vault.files.createText("Index.md", "See ![[Home.tasks]]\n", OnConflict.FAIL,
				TestVault.ALICE, "c-other-1");
		TaskListWriteResult result = update(list.id(), "{\"name\": \"House\"}", "{\"name\": \"Home\"}");
		TaskList renamed = result.lists().get(0);
		assertThat(renamed.name()).isEqualTo("House");
		assertThat(renamed.path()).isEqualTo("Tasks/House.tasks");
		assertThat(result.moved().from()).isEqualTo("Tasks/Home.tasks");
		assertThat(result.files()).extracting((f) -> f.path()).containsExactly("Tasks/House.tasks");
		assertThat(Files.exists(this.fx.vault.root.resolve("Tasks/Home.tasks"))).isFalse();
		assertThat(this.fx.read("Index.md")).isEqualTo("See ![[House.tasks]]\n");
		// A changed color from a stale client conflicts; the same change again is a no-op.
		update(list.id(), "{\"color\": \"green\"}", null);
		NotesException conflict = exception(() -> update(list.id(), "{\"color\": \"red\"}", "{\"color\": null}"));
		assertThat(conflict.code()).isEqualTo(ErrorCode.TASK_CONFLICT);
		assertThat(update(list.id(), "{\"color\": \"green\"}", "{\"color\": null}").files()).isEmpty();
	}

	@Test
	void deletingAListMovesItsFileToTheTrash() throws Exception {
		TaskList list = this.fx.createList("Errands");
		Task task = this.fx.create("{\"title\": \"Post office\", \"listId\": \"" + list.id() + "\"}");
		int mark = this.fx.mark();
		TaskListWriteResult result = this.fx.lists.delete(list.id(), TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(result.trash().originalPath()).isEqualTo("Tasks/Errands.tasks");
		assertThat(this.fx.eventsSince(mark)).containsSubsequence("file.deleted", "trash.changed", "list.changed",
				"history.committed");
		assertThat(this.fx.lists.lists().lists()).isEmpty();
		assertThat(codeOf(() -> this.fx.get(task.id()))).isEqualTo(ErrorCode.NOT_FOUND);
		// Restoring the file from the trash brings the list back.
		this.fx.vault.trash.restore(result.trash().id(), null, TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(this.fx.get(task.id()).title()).isEqualTo("Post office");
	}

	@Test
	void listsAreReordered() throws Exception {
		TaskList a = this.fx.createList("A");
		TaskList b = this.fx.createList("B");
		TaskList c = this.fx.createList("C");
		TaskListWriteResult result = this.fx.lists.reorder(new ReorderRequest(List.of(c.id()), null),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(result.lists()).extracting(TaskList::id).containsExactly(c.id());
		assertThat(this.fx.lists.lists().lists()).extracting(TaskList::name).containsExactly("C", "A", "B");
		this.fx.lists.reorder(new ReorderRequest(List.of(a.id(), c.id()), b.id()), TestVault.ALICE,
				TaskFixture.CLIENT);
		assertThat(this.fx.lists.lists().lists()).extracting(TaskList::name).containsExactly("B", "A", "C");
	}

	@Test
	void sectionsGroupTasks() throws Exception {
		TaskList list = this.fx.createList("Garden");
		TaskList withTodo = this.fx.lists.createSection(list.id(), new SectionRequest("To do"), TestVault.ALICE,
				TaskFixture.CLIENT).lists().get(0);
		TaskList withBoth = this.fx.lists.createSection(list.id(), new SectionRequest("Doing"), TestVault.ALICE,
				TaskFixture.CLIENT).lists().get(0);
		assertThat(withTodo.sections()).extracting(TaskSection::name).containsExactly("To do");
		List<TaskSection> sections = withBoth.sections();
		assertThat(sections).extracting(TaskSection::name).containsExactly("To do", "Doing");
		String todo = sections.get(0).id();
		String doing = sections.get(1).id();
		Task weed = this.fx.create("{\"title\": \"Weed\", \"listId\": \"" + list.id() + "\", \"sectionId\": \""
				+ todo + "\"}");
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"X\", \"listId\": \"" + list.id()
				+ "\", \"sectionId\": \"NOPE\"}"))).isEqualTo(ErrorCode.BAD_REQUEST);
		// A Kanban move: into another section.
		this.fx.tasks.reorder(new ReorderTasksRequest(list.id(), doing, null, List.of(weed.id()), null),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(this.fx.get(weed.id()).sectionId()).isEqualTo(doing);
		this.fx.lists.renameSection(list.id(), doing, new SectionRequest("In progress"), TestVault.ALICE,
				TaskFixture.CLIENT);
		TaskList reordered = this.fx.lists.reorderSections(list.id(), new ReorderRequest(List.of(doing), null),
				TestVault.ALICE, TaskFixture.CLIENT).lists().get(0);
		assertThat(reordered.sections()).extracting(TaskSection::name).containsExactly("In progress", "To do");
		int mark = this.fx.mark();
		this.fx.lists.deleteSection(list.id(), doing, TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(this.fx.get(weed.id()).sectionId()).isNull();
		assertThat(this.fx.eventsSince(mark)).containsExactly("file.changed", "task.changed", "list.changed");
		assertThat(codeOf(() -> this.fx.lists.deleteSection(list.id(), doing, TestVault.ALICE, TaskFixture.CLIENT)))
			.isEqualTo(ErrorCode.NOT_FOUND);
	}

}
