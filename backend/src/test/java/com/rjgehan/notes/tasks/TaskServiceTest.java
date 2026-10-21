package com.rjgehan.notes.tasks;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.HistoryEntry;
import com.rjgehan.notes.api.dto.ReorderTasksRequest;
import com.rjgehan.notes.api.dto.SectionRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.api.dto.TaskWriteResult;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.TaskEvent;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

class TaskServiceTest {

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

	// ---------------------------------------------------------------- create

	@Test
	void aTaskWithoutAListGoesToTheInboxCreatedOnFirstUse() throws Exception {
		int mark = this.fx.mark();
		TaskWriteResult result = this.fx.tasks.create(TaskFixture.json("{\"title\": \"  Buy milk \"}"),
				TestVault.ALICE, TaskFixture.CLIENT);
		Task task = result.task();
		assertThat(task.title()).isEqualTo("Buy milk");
		assertThat(task.status()).isEqualTo(TaskStatus.OPEN);
		assertThat(task.order()).isEqualTo("a0");
		assertThat(task.createdAt()).isEqualTo(this.fx.vault.clock.instant());
		assertThat(Ulid.PATTERN.matcher(task.id()).matches()).isTrue();
		TaskList inbox = this.fx.lists.lists().lists().get(0);
		assertThat(inbox.name()).isEqualTo("Inbox");
		assertThat(inbox.path()).isEqualTo("Tasks/Inbox.tasks");
		assertThat(task.listId()).isEqualTo(inbox.id());
		assertThat(result.files()).extracting((f) -> f.path()).containsExactly("Tasks/Inbox.tasks");
		// The caller is not sent its own list.changed and folder.created: the result carries them.
		assertThat(result.lists()).containsExactly(inbox);
		assertThat(result.createdFolders()).containsExactly("Tasks");
		assertThat(this.fx.eventsSince(mark)).containsExactly("folder.created", "file.created", "list.changed",
				"file.changed", "task.created");
		TaskWriteResult second = this.fx.tasks.create(TaskFixture.json("{\"title\": \"Eggs\"}"), TestVault.ALICE,
				TaskFixture.CLIENT);
		assertThat(second.lists()).isEmpty();
		assertThat(second.createdFolders()).isEmpty();
		String file = this.fx.read("Tasks/Inbox.tasks");
		assertThat(file).startsWith("{\n  \"type\": \"notesapp-tasks\",\n  \"version\": 1,\n").endsWith("}\n")
			.contains("\"title\": \"Buy milk\"");
	}

	@Test
	void fieldsAreValidated() throws Exception {
		assertThat(codeOf(() -> this.fx.create("{}"))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"\"}"))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"a\\nb\"}"))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"due\": \"tomorrow\"}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"priority\": 4}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"tags\": [\"1984\"]}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"links\": [\"../etc/passwd\"]}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"recurrence\": {\"rrule\": \"FREQ=HOURLY\"}}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create(
				"{\"title\": \"x\", \"reminders\": [{\"at\": \"2026-10-20\"}]}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"x\", \"listId\": \"NOPE\"}")))
			.isEqualTo(ErrorCode.NOT_FOUND);
		// Nothing was created by the failures.
		assertThat(Files.exists(this.fx.vault.root.resolve("Tasks"))).isFalse();
	}

	@Test
	void valuesAreNormalized() throws Exception {
		Task task = this.fx.create("""
				{"title": "Plan", "tags": ["#Home", "home", "work/q4"], "links": ["Projects/Plan.md"],
				 "recurrence": {"rrule": "RRULE:freq=weekly"}, "notes": "  ",
				 "reminders": [{"at": "2026-10-20T09:00"}, {"at": "2026-10-20T09:00"}]}
				""");
		assertThat(task.tags()).containsExactly("Home", "work/q4");
		assertThat(task.links()).containsExactly("Projects/Plan.md");
		assertThat(task.recurrence().rrule()).isEqualTo("FREQ=WEEKLY");
		assertThat(task.notes()).isNull();
		assertThat(task.reminders()).hasSize(1);
	}

	@Test
	void newTasksArePlacedWithFractionalKeys() throws Exception {
		Task a = this.fx.create("{\"title\": \"A\"}");
		Task b = this.fx.create("{\"title\": \"B\"}");
		Task c = this.fx.create("{\"title\": \"C\", \"after\": null}");
		Task d = this.fx.create("{\"title\": \"D\", \"after\": \"" + a.id() + "\"}");
		assertThat(List.of(a.order(), b.order(), c.order(), d.order())).containsExactly("a0", "a1", "Zz", "a0V");
		TasksResponse list = this.fx.tasks.query("list", null, null, null, null, null, null, null, null, null, null);
		assertThat(list.tasks()).extracting(Task::title).containsExactly("C", "A", "D", "B");
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"E\", \"after\": \"UNKNOWN\"}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void subtasksAreAtMostThreeLevelsDeep() throws Exception {
		Task a = this.fx.create("{\"title\": \"A\"}");
		Task b = this.fx.create("{\"title\": \"B\", \"parentId\": \"" + a.id() + "\"}");
		Task c = this.fx.create("{\"title\": \"C\", \"parentId\": \"" + b.id() + "\"}");
		assertThat(c.listId()).isEqualTo(a.listId());
		assertThat(codeOf(() -> this.fx.create("{\"title\": \"D\", \"parentId\": \"" + c.id() + "\"}")))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		// No cycles: A cannot go under its own subtask.
		assertThat(codeOf(() -> this.fx.patch(a.id(), "{\"parentId\": \"" + c.id() + "\"}", null)))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		// B's subtree (B, C) is two deep: it fits under a new top-level task, not under a subtask.
		Task e = this.fx.create("{\"title\": \"E\"}");
		Task f = this.fx.create("{\"title\": \"F\", \"parentId\": \"" + e.id() + "\"}");
		assertThat(codeOf(() -> this.fx.patch(b.id(), "{\"parentId\": \"" + f.id() + "\"}", null)))
			.isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(this.fx.patch(b.id(), "{\"parentId\": \"" + e.id() + "\"}", null).task().parentId())
			.isEqualTo(e.id());
		assertThat(this.fx.patch(b.id(), "{\"parentId\": null}", null).task().parentId()).isNull();
	}

	// ---------------------------------------------------------------- update

	@Test
	void anUpdateChangesOnlyTheGivenFields() throws Exception {
		Task task = this.fx.create("{\"title\": \"Pay rent\", \"due\": \"2026-11-01\", \"priority\": 2}");
		this.fx.vault.clock.advance(Duration.ofMinutes(5));
		int mark = this.fx.mark();
		Task updated = this.fx.patch(task.id(), "{\"title\": \"Pay the rent\", \"due\": null}", null).task();
		assertThat(updated.title()).isEqualTo("Pay the rent");
		assertThat(updated.due()).isNull();
		assertThat(updated.priority()).isEqualTo(2);
		assertThat(updated.updatedAt()).isEqualTo(this.fx.vault.clock.instant());
		assertThat(updated.createdAt()).isEqualTo(task.createdAt());
		assertThat(this.fx.eventsSince(mark)).containsExactly("file.changed", "task.changed");
		assertThat(this.fx.read("Tasks/Inbox.tasks")).doesNotContain("\"due\"");
	}

	@Test
	void repeatingAnUpdateChangesNothing() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		this.fx.patch(task.id(), "{\"priority\": 3}", null);
		String before = this.fx.read("Tasks/Inbox.tasks");
		int mark = this.fx.mark();
		TaskWriteResult again = this.fx.patch(task.id(), "{\"priority\": 3}", "{\"priority\": 0}");
		assertThat(again.files()).isEmpty();
		assertThat(again.task().priority()).isEqualTo(3);
		assertThat(this.fx.eventsSince(mark)).isEmpty();
		assertThat(this.fx.read("Tasks/Inbox.tasks")).isEqualTo(before);
	}

	@Test
	void aFieldChangedOnTheServerSinceTheClientReadItIsAConflict() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\", \"priority\": 1}");
		this.fx.patch(task.id(), "{\"title\": \"A from the phone\"}", "{\"title\": \"A\"}");
		NotesException conflict = exception(
				() -> this.fx.patch(task.id(), "{\"title\": \"A from the PC\"}", "{\"title\": \"A\"}"));
		assertThat(conflict.code()).isEqualTo(ErrorCode.TASK_CONFLICT);
		assertThat(conflict.getBody().getProperties()).containsKey("task");
		assertThat(conflict.getBody().getProperties().get("fields")).isEqualTo(List.of("title"));
		// Another field of the same task, edited from the same stale state, is fine.
		Task merged = this.fx.patch(task.id(), "{\"priority\": 3}", "{\"priority\": 1}").task();
		assertThat(merged.title()).isEqualTo("A from the phone");
		assertThat(merged.priority()).isEqualTo(3);
	}

	@Test
	void twoDevicesEditingDifferentTasksOfOneListNeverConflict() throws Exception {
		List<Task> created = new ArrayList<>();
		for (int i = 0; i < 6; i++) {
			created.add(this.fx.create("{\"title\": \"Task " + i + "\"}"));
		}
		ExecutorService pool = Executors.newFixedThreadPool(6);
		CountDownLatch start = new CountDownLatch(1);
		try {
			List<Future<Object>> futures = new ArrayList<>();
			for (Task task : created) {
				futures.add(pool.submit((Callable<Object>) () -> {
					start.await();
					for (int round = 0; round < 15; round++) {
						this.fx.patch(task.id(), "{\"notes\": \"edit " + round + "\"}", null);
					}
					return null;
				}));
			}
			start.countDown();
			for (Future<Object> future : futures) {
				future.get();
			}
		}
		finally {
			pool.shutdownNow();
		}
		for (Task task : created) {
			assertThat(this.fx.get(task.id()).notes()).isEqualTo("edit 14");
		}
		String file = this.fx.read("Tasks/Inbox.tasks");
		assertThat(file.split("\"notes\": \"edit 14\"", -1)).hasSize(7);
	}

	@Test
	void movingATaskToAnotherListTakesItsSubtasks() throws Exception {
		Task parent = this.fx.create("{\"title\": \"Trip\"}");
		Task child = this.fx.create("{\"title\": \"Book hotel\", \"parentId\": \"" + parent.id() + "\"}");
		TaskList travel = this.fx.createList("Travel");
		this.fx.lists.createSection(travel.id(), new SectionRequest("Later"),
				TestVault.ALICE, TaskFixture.CLIENT);
		int mark = this.fx.mark();
		TaskWriteResult moved = this.fx.patch(parent.id(), "{\"listId\": \"" + travel.id() + "\"}", null);
		assertThat(moved.task().listId()).isEqualTo(travel.id());
		assertThat(moved.changed()).extracting(Task::id).containsExactly(child.id());
		assertThat(this.fx.get(child.id()).listId()).isEqualTo(travel.id());
		assertThat(this.fx.get(child.id()).parentId()).isEqualTo(parent.id());
		// The file that gains the tasks is written first; then the one that loses them.
		assertThat(moved.files()).extracting((f) -> f.path()).containsExactly("Tasks/Travel.tasks",
				"Tasks/Inbox.tasks");
		assertThat(this.fx.eventsSince(mark)).containsExactly("file.changed", "file.changed", "task.changed",
				"task.changed");
		assertThat(this.fx.read("Tasks/Inbox.tasks")).doesNotContain("Trip", "Book hotel");
		assertThat(this.fx.read("Tasks/Travel.tasks")).contains("Trip", "Book hotel");
	}

	// ---------------------------------------------------------------- complete

	@Test
	void completingClosesTheTaskAndItsOpenSubtasks() throws Exception {
		Task parent = this.fx.create("{\"title\": \"Move\"}");
		Task child = this.fx.create("{\"title\": \"Pack\", \"parentId\": \"" + parent.id() + "\"}");
		TaskWriteResult done = this.fx.tasks.complete(parent.id(), new CompleteTaskRequest("Europe/Paris", null, null),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(done.rolledForward()).isFalse();
		assertThat(done.task().status()).isEqualTo(TaskStatus.DONE);
		assertThat(done.task().completedAt()).isEqualTo(this.fx.vault.clock.instant());
		assertThat(done.changed()).extracting(Task::id).containsExactly(child.id());
		assertThat(this.fx.get(child.id()).status()).isEqualTo(TaskStatus.DONE);
		// Completing again changes nothing.
		assertThat(this.fx.tasks.complete(parent.id(), null, TestVault.ALICE, TaskFixture.CLIENT).files()).isEmpty();
		Task reopened = this.fx.tasks.uncomplete(parent.id(), TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(reopened.status()).isEqualTo(TaskStatus.OPEN);
		assertThat(reopened.completedAt()).isNull();
		assertThat(this.fx.get(child.id()).status()).isEqualTo(TaskStatus.DONE);
	}

	@Test
	void completingARecurringTaskRollsItForward() throws Exception {
		Task task = this.fx.create("""
				{"title": "Water plants", "due": "2026-10-14T08:00", "start": "2026-10-12",
				 "recurrence": {"rrule": "FREQ=WEEKLY", "from": "due"}, "reminders": [{"at": "2026-10-14T07:30"}]}
				""");
		Task step = this.fx.create("{\"title\": \"Fill can\", \"parentId\": \"" + task.id() + "\"}");
		this.fx.tasks.complete(step.id(), null, TestVault.ALICE, TaskFixture.CLIENT);
		TaskWriteResult rolled = this.fx.tasks.complete(task.id(),
				new CompleteTaskRequest(null, "2026-10-14", TaskFixture.json("{\"due\": \"2026-10-14T08:00\"}")),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(rolled.rolledForward()).isTrue();
		Task next = rolled.task();
		assertThat(next.status()).isEqualTo(TaskStatus.OPEN);
		assertThat(next.completedAt()).isNull();
		assertThat(next.due()).isEqualTo("2026-10-21T08:00");
		assertThat(next.start()).isEqualTo("2026-10-19");
		assertThat(next.reminders()).extracting((r) -> r.at()).containsExactly("2026-10-21T07:30");
		// The subtask reopens for the next occurrence.
		assertThat(rolled.changed()).extracting(Task::id).containsExactly(step.id());
		assertThat(this.fx.get(step.id()).status()).isEqualTo(TaskStatus.OPEN);
		// A retry (or another device) completing the same occurrence changes nothing.
		TaskWriteResult retry = this.fx.tasks.complete(task.id(),
				new CompleteTaskRequest(null, "2026-10-14", TaskFixture.json("{\"due\": \"2026-10-14T08:00\"}")),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(retry.rolledForward()).isFalse();
		assertThat(retry.files()).isEmpty();
		assertThat(this.fx.get(task.id()).due()).isEqualTo("2026-10-21T08:00");
	}

	@Test
	void theLastOccurrenceClosesTheTask() throws Exception {
		Task task = this.fx.create("""
				{"title": "Physio", "due": "2026-10-14", "recurrence": {"rrule": "FREQ=DAILY;COUNT=2"}}
				""");
		Task first = this.fx.tasks.complete(task.id(), new CompleteTaskRequest(null, "2026-10-14", null),
				TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(first.due()).isEqualTo("2026-10-15");
		assertThat(first.recurrence().rrule()).isEqualTo("FREQ=DAILY;COUNT=1");
		Task last = this.fx.tasks.complete(task.id(), new CompleteTaskRequest(null, "2026-10-15", null),
				TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(last.status()).isEqualTo(TaskStatus.DONE);
	}

	// ---------------------------------------------------------------- reorder and delete

	@Test
	void reorderingMovesOnlyTheMovedTasks() throws Exception {
		Task a = this.fx.create("{\"title\": \"A\"}");
		Task b = this.fx.create("{\"title\": \"B\"}");
		Task c = this.fx.create("{\"title\": \"C\"}");
		TaskWriteResult result = this.fx.tasks.reorder(
				new ReorderTasksRequest(a.listId(), null, null, List.of(c.id()), a.id()), TestVault.ALICE,
				TaskFixture.CLIENT);
		assertThat(result.changed()).extracting(Task::id).containsExactly(c.id());
		assertThat(order()).containsExactly("A", "C", "B");
		// The same drop again is a no-op.
		assertThat(this.fx.tasks
			.reorder(new ReorderTasksRequest(a.listId(), null, null, List.of(c.id()), a.id()), TestVault.ALICE,
					TaskFixture.CLIENT)
			.files()).isEmpty();
		this.fx.tasks.reorder(new ReorderTasksRequest(a.listId(), null, null, List.of(b.id(), a.id()), null),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(order()).containsExactly("B", "A", "C");
		assertThat(codeOf(() -> this.fx.tasks.reorder(
				new ReorderTasksRequest(a.listId(), null, null, List.of(a.id()), "NOT-A-SIBLING"), TestVault.ALICE,
				TaskFixture.CLIENT)))
			.isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void unusableOrderKeysFromAHandEditAreRenumbered() throws Exception {
		Task a = this.fx.create("{\"title\": \"A\"}");
		Task b = this.fx.create("{\"title\": \"B\"}");
		Task c = this.fx.create("{\"title\": \"C\"}");
		String file = this.fx.read("Tasks/Inbox.tasks");
		this.fx.write("Tasks/Inbox.tasks", file.replace("\"order\": \"a0\"", "\"order\": \"1\"")
			.replace("\"order\": \"a1\"", "\"order\": \"2\""));
		TaskWriteResult result = this.fx.tasks.reorder(
				new ReorderTasksRequest(a.listId(), null, null, List.of(c.id()), a.id()), TestVault.ALICE,
				TaskFixture.CLIENT);
		assertThat(result.changed()).extracting(Task::id).contains(c.id(), b.id());
		assertThat(order()).containsExactly("A", "C", "B");
	}

	@Test
	void deletingATaskDeletesItsSubtasks() throws Exception {
		Task parent = this.fx.create("{\"title\": \"P\"}");
		Task child = this.fx.create("{\"title\": \"C\", \"parentId\": \"" + parent.id() + "\"}");
		Task other = this.fx.create("{\"title\": \"O\"}");
		int mark = this.fx.mark();
		TaskWriteResult result = this.fx.tasks.delete(parent.id(), TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(result.deleted()).containsExactly(parent.id(), child.id());
		assertThat(this.fx.eventsSince(mark)).containsExactly("file.changed", "task.deleted", "task.deleted");
		assertThat(codeOf(() -> this.fx.get(child.id()))).isEqualTo(ErrorCode.NOT_FOUND);
		assertThat(this.fx.get(other.id())).isNotNull();
		assertThat(codeOf(() -> this.fx.tasks.delete(parent.id(), TestVault.ALICE, TaskFixture.CLIENT)))
			.isEqualTo(ErrorCode.NOT_FOUND);
	}

	// ---------------------------------------------------------------- data safety

	@Test
	void aMalformedFileIsReportedAndNeverWritten() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		String broken = this.fx.read("Tasks/Inbox.tasks").replace("\"tasks\": [", "\"tasks\": [ oops");
		this.fx.write("Tasks/Inbox.tasks", broken);
		this.fx.write("Tasks/Notes.tasks", "these are not tasks");
		this.fx.vault.reconciler.fullRescan(false);
		TasksResponse view = this.fx.tasks.query("list", null, null, null, null, null, null, null, null, null, null);
		assertThat(view.problems()).extracting((p) -> p.path() + ": " + p.reason())
			.anyMatch((p) -> p.startsWith("Tasks/Inbox.tasks: not valid JSON"))
			.anyMatch((p) -> p.startsWith("Tasks/Notes.tasks: not valid JSON"));
		assertThat(view.tasks()).isEmpty();
		assertThat(codeOf(() -> this.fx.patch(task.id(), "{\"priority\": 1}", null))).isEqualTo(ErrorCode.NOT_FOUND);
		// A new task without a list does not replace the broken Inbox.
		NotesException refused = exception(() -> this.fx.create("{\"title\": \"B\"}"));
		assertThat(refused.code()).isEqualTo(ErrorCode.MALFORMED_FILE);
		assertThat(this.fx.read("Tasks/Inbox.tasks")).isEqualTo(broken);
		assertThat(this.fx.read("Tasks/Notes.tasks")).isEqualTo("these are not tasks");
	}

	@Test
	void aFileBrokenBetweenTheLookupAndTheWriteIsNotWritten() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		// Broken on disk, but the watcher has not told the index yet.
		String broken = this.fx.read("Tasks/Inbox.tasks").replace("{\n  \"type\"", "{\n  \"type\": 1, \"x\"");
		this.fx.write("Tasks/Inbox.tasks", broken);
		NotesException refused = exception(() -> this.fx.patch(task.id(), "{\"priority\": 1}", null));
		assertThat(refused.code()).isEqualTo(ErrorCode.MALFORMED_FILE);
		assertThat(this.fx.read("Tasks/Inbox.tasks")).isEqualTo(broken);
	}

	@Test
	void aFileFromANewerVersionIsOnlyRead() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		String newer = this.fx.read("Tasks/Inbox.tasks").replace("\"version\": 1", "\"version\": 2");
		this.fx.write("Tasks/Inbox.tasks", newer);
		this.fx.vault.reconciler.fullRescan(false);
		assertThat(this.fx.get(task.id()).title()).isEqualTo("A");
		assertThat(this.fx.lists.lists().lists().get(0).writable()).isFalse();
		assertThat(codeOf(() -> this.fx.patch(task.id(), "{\"priority\": 1}", null)))
			.isEqualTo(ErrorCode.MALFORMED_FILE);
		assertThat(this.fx.read("Tasks/Inbox.tasks")).isEqualTo(newer);
	}

	@Test
	void aHandEditIsKeptAndCommittedAsExternalBeforeTheNextWrite() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		this.fx.vault.flush();
		this.fx.write("Tasks/Inbox.tasks",
				this.fx.read("Tasks/Inbox.tasks").replace("\"title\": \"A\"", "\"title\": \"A (edited in vim)\""));
		Task updated = this.fx.patch(task.id(), "{\"priority\": 2}", null).task();
		assertThat(updated.title()).isEqualTo("A (edited in vim)");
		assertThat(updated.priority()).isEqualTo(2);
		this.fx.vault.flush();
		List<HistoryEntry> history = this.fx.vault.history.list("Tasks/Inbox.tasks", 10, 0).entries();
		assertThat(history).extracting(HistoryEntry::authorName).startsWith("Alice", "External");
	}

	@Test
	void aCopiedListFileIsReportedNotMerged() throws Exception {
		Task task = this.fx.create("{\"title\": \"A\"}");
		this.fx.write("Tasks/Inbox copy.tasks", this.fx.read("Tasks/Inbox.tasks"));
		this.fx.vault.reconciler.fullRescan(false);
		TasksResponse view = this.fx.tasks.query("list", null, null, null, null, null, null, null, null, null, null);
		assertThat(view.lists()).hasSize(1);
		assertThat(view.tasks()).extracting(Task::id).containsExactly(task.id());
		// The first file in path order is used; the other is reported and left alone.
		String used = view.lists().get(0).path();
		String other = used.equals("Tasks/Inbox.tasks") ? "Tasks/Inbox copy.tasks" : "Tasks/Inbox.tasks";
		assertThat(used).isEqualTo("Tasks/Inbox copy.tasks");
		assertThat(view.problems()).anyMatch((p) -> p.path().equals(other) && p.reason().contains("list id"));
		String untouched = this.fx.read(other);
		this.fx.patch(task.id(), "{\"priority\": 1}", null);
		assertThat(this.fx.read(used)).contains("\"priority\": 1");
		assertThat(this.fx.read(other)).isEqualTo(untouched);
	}

	@Test
	void eventsCarryTheOriginForEchoSuppression() throws Exception {
		int mark = this.fx.mark();
		this.fx.create("{\"title\": \"A\"}");
		TaskEvent created = (TaskEvent) this.fx.vault.hub.published.stream()
			.skip(mark)
			.filter((event) -> event instanceof TaskEvent)
			.findFirst()
			.orElseThrow();
		assertThat(created.eventName()).isEqualTo("task.created");
		assertThat(created.echoOrigin()).isEqualTo(TaskFixture.CLIENT);
	}

	private List<String> order() {
		return this.fx.tasks.query("list", null, null, null, null, null, null, null, null, null, null)
			.tasks()
			.stream()
			.map(Task::title)
			.toList();
	}

	static ErrorCode codeOf(ThrowingRunnable action) {
		return exception(action).code();
	}

	static NotesException exception(ThrowingRunnable action) {
		try {
			action.run();
		}
		catch (NotesException ex) {
			return ex;
		}
		catch (Exception ex) {
			throw new AssertionError(ex);
		}
		throw new AssertionError("expected a NotesException");
	}

	@FunctionalInterface
	interface ThrowingRunnable {

		void run() throws Exception;

	}

}
