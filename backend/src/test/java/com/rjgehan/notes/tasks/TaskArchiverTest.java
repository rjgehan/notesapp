package com.rjgehan.notes.tasks;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/** The archive rollover: tasks closed more than 90 days ago move to Tasks/Archive/<List> <YYYY>.tasks. */
class TaskArchiverTest {

	@TempDir
	Path dir;

	private TaskFixture fx;

	private TaskList home;

	@BeforeEach
	void setUp() throws Exception {
		this.fx = TaskFixture.start(this.dir);
		this.home = this.fx.createList("Home");
	}

	@AfterEach
	void tearDown() {
		this.fx.close();
	}

	private Task task(String title, String extra) throws Exception {
		return this.fx.create("{\"title\": \"" + title + "\", \"listId\": \"" + this.home.id() + "\"" + extra + "}");
	}

	private void complete(Task task) throws Exception {
		this.fx.tasks.complete(task.id(), null, TestVault.ALICE, TaskFixture.CLIENT);
	}

	@Test
	void oldClosedTasksRollIntoTheArchiveOfTheirYear() throws Exception {
		Task old = task("Old", "");
		Task parent = task("Parent", "");
		Task child = task("Child", ", \"parentId\": \"" + parent.id() + "\"");
		Task openParent = task("Open parent", "");
		Task doneChild = task("Done child", ", \"parentId\": \"" + openParent.id() + "\"");
		complete(old);
		complete(parent);
		complete(doneChild);
		Task open = task("Still open", "");
		this.fx.vault.clock.advance(Duration.ofDays(80));
		Task recent = task("Recent", "");
		complete(recent);
		this.fx.vault.clock.advance(Duration.ofDays(11));
		int mark = this.fx.mark();

		assertThat(this.fx.archiver.rollOver()).isEqualTo(3);

		String archive = "Tasks/Archive/Home 2026.tasks";
		assertThat(this.fx.read(archive)).contains("\"archive\": true", "Old", "Parent", "Child")
			.doesNotContain("Done child", "Recent");
		assertThat(this.fx.read("Tasks/Home.tasks")).doesNotContain("\"Old\"", "\"Parent\"", "\"Child\"")
			.contains("Done child", "Recent", "Still open", "Open parent");
		// Alice's pending edits are committed under her name before the rollover writes as NotesApp.
		assertThat(this.fx.eventsSince(mark)).containsExactly("folder.created", "file.created", "file.changed",
				"list.changed", "history.committed");
		this.fx.vault.flush();
		assertThat(this.fx.vault.history.list(archive, 5, 0).entries()).extracting((e) -> e.authorName())
			.containsExactly("NotesApp");
		Task archived = this.fx.get(old.id());
		assertThat(archived.archived()).isTrue();
		assertThat(archived.listId()).isEqualTo(this.home.id());
		assertThat(this.fx.get(child.id()).parentId()).isEqualTo(parent.id());
		// Completed shows archived tasks too; the list view does not.
		TasksResponse completed = this.fx.tasks.query("completed", null, null, null, null, null, null, null, null,
				null, null);
		assertThat(completed.tasks()).extracting(Task::title).contains("Old", "Parent", "Child", "Recent",
				"Done child");
		TasksResponse all = this.fx.tasks.query("list", this.home.id(), null, null, "all", null, null, null, null,
				null, null);
		assertThat(all.tasks()).extracting(Task::title).doesNotContain("Old");
		assertThat(this.fx.get(open.id()).archived()).isFalse();
		// Nothing more to move: a second run changes nothing.
		assertThat(this.fx.archiver.rollOver()).isZero();
	}

	@Test
	void laterRolloversAddToTheArchiveOfTheSameYear() throws Exception {
		Task first = task("First", "");
		complete(first);
		this.fx.vault.clock.advance(Duration.ofDays(14));
		Task second = task("Second", "");
		complete(second);
		this.fx.vault.clock.advance(Duration.ofDays(80));
		assertThat(this.fx.archiver.rollOver()).isEqualTo(1);
		this.fx.vault.clock.advance(Duration.ofDays(20));
		assertThat(this.fx.archiver.rollOver()).isEqualTo(1);
		assertThat(this.fx.read("Tasks/Archive/Home 2026.tasks")).contains("First", "Second");
		Task third = task("Third", "");
		complete(third);
		this.fx.vault.clock.advance(Duration.ofDays(91));
		assertThat(this.fx.archiver.rollOver()).isEqualTo(1);
		assertThat(this.fx.read("Tasks/Archive/Home 2027.tasks")).contains("Third");
	}

	@Test
	void reopeningAnArchivedTaskMovesItBack() throws Exception {
		Task parent = task("Parent", "");
		Task child = task("Child", ", \"parentId\": \"" + parent.id() + "\"");
		complete(parent);
		this.fx.vault.clock.advance(Duration.ofDays(100));
		this.fx.archiver.rollOver();
		Task reopened = this.fx.tasks.uncomplete(parent.id(), TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(reopened.archived()).isFalse();
		assertThat(reopened.status()).isEqualTo(TaskStatus.OPEN);
		assertThat(this.fx.get(child.id()).archived()).isFalse();
		assertThat(this.fx.get(child.id()).status()).isEqualTo(TaskStatus.DONE);
		assertThat(this.fx.read("Tasks/Archive/Home 2026.tasks")).doesNotContain("Parent", "Child");
	}

	@Test
	void anArchiveNameTakenBySomethingElseIsNotOverwritten() throws Exception {
		this.fx.write("Tasks/Archive/Home 2026.tasks", "my own notes");
		this.fx.vault.reconciler.fullRescan(false);
		Task done = task("Done", "");
		complete(done);
		this.fx.vault.clock.advance(Duration.ofDays(91));
		assertThat(this.fx.archiver.rollOver()).isEqualTo(1);
		assertThat(this.fx.read("Tasks/Archive/Home 2026.tasks")).isEqualTo("my own notes");
		assertThat(this.fx.read("Tasks/Archive/Home 2026 1.tasks")).contains("Done");
	}

	@Test
	void aMalformedListIsLeftAlone() throws Exception {
		Task done = task("Done", "");
		complete(done);
		this.fx.vault.clock.advance(Duration.ofDays(91));
		String broken = this.fx.read("Tasks/Home.tasks") + "trailing garbage";
		this.fx.write("Tasks/Home.tasks", broken);
		assertThat(this.fx.archiver.rollOver()).isZero();
		assertThat(this.fx.read("Tasks/Home.tasks")).isEqualTo(broken);
		assertThat(Files.exists(this.fx.vault.root.resolve("Tasks/Archive"))).isFalse();
	}

}
