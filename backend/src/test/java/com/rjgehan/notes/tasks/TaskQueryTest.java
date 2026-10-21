package com.rjgehan.notes.tasks;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static com.rjgehan.notes.tasks.TaskServiceTest.codeOf;
import static org.assertj.core.api.Assertions.assertThat;

/** The views of {@code GET /api/tasks}; the client's day is 2026-10-16. */
class TaskQueryTest {

	@TempDir
	Path dir;

	private TaskFixture fx;

	private TaskList home;

	private TaskList work;

	@BeforeEach
	void setUp() throws Exception {
		this.fx = TaskFixture.start(this.dir);
		this.home = this.fx.createList("Home");
		this.work = this.fx.createList("Work");
		task(this.home, "Overdue bill #bills", "\"due\": \"2026-10-10\", \"priority\": 3");
		task(this.home, "Today at nine", "\"due\": \"2026-10-16T09:00\"");
		task(this.home, "Today all day", "\"due\": \"2026-10-16\", \"priority\": 1");
		task(this.home, "Started earlier", "\"start\": \"2026-10-01\", \"due\": \"2026-12-01\"");
		task(this.home, "Next week", "\"due\": \"2026-10-22\", \"tags\": [\"garden/roses\"]");
		task(this.home, "In a month", "\"due\": \"2026-11-16\"");
		task(this.work, "Report", "\"due\": \"2026-10-17\", \"notes\": \"Quarterly numbers for Café\"");
		task(this.work, "Someday", "\"priority\": 2");
	}

	@AfterEach
	void tearDown() {
		this.fx.close();
	}

	private Task task(TaskList list, String title, String fields) throws Exception {
		return this.fx.create("{\"title\": \"" + title + "\", \"listId\": \"" + list.id() + "\""
				+ (fields.isEmpty() ? "" : ", " + fields) + "}");
	}

	private List<String> titles(String view, String list, String tag, String priority, String status, String q) {
		TasksResponse response = this.fx.tasks.query(view, list, tag, priority, status, q, "2026-10-16", null, null,
				null, null);
		return response.tasks().stream().map(Task::title).toList();
	}

	@Test
	void todayHasOverdueDueAndStartedTasks() {
		// By due date (a started task by its due date too); an all-day task before the times of its day.
		assertThat(titles("today", null, null, null, null, null)).containsExactly("Overdue bill #bills",
				"Today all day", "Today at nine", "Started earlier");
	}

	@Test
	void upcomingCoversTheNextDays() {
		assertThat(titles("upcoming", null, null, null, null, null)).containsExactly("Today all day", "Today at nine",
				"Report", "Next week");
		TasksResponse twoDays = this.fx.tasks.query("upcoming", null, null, null, null, null, "2026-10-16", null, 2,
				null, null);
		assertThat(twoDays.tasks()).extracting(Task::title).containsExactly("Today all day", "Today at nine",
				"Report");
	}

	@Test
	void theDayComesFromTheClientsTimeZone() {
		// 2026-10-16T12:00Z is already the 17th in Auckland.
		TasksResponse auckland = this.fx.tasks.query("today", null, null, null, null, null, null, "Pacific/Auckland",
				null, null, null);
		assertThat(auckland.tasks()).extracting(Task::title).contains("Report");
		TasksResponse paris = this.fx.tasks.query("today", null, null, null, null, null, null, "Europe/Paris", null,
				null, null);
		assertThat(paris.tasks()).extracting(Task::title).doesNotContain("Report");
		assertThat(codeOf(() -> this.fx.tasks.query("today", null, null, null, null, null, null, null, null, null,
				null))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> this.fx.tasks.query("today", null, null, null, null, null, null, "Mars/Olympus",
				null, null, null))).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void filtersCombine() {
		assertThat(titles("list", this.work.id(), null, null, null, null)).containsExactly("Report", "Someday");
		assertThat(titles("list", null, "garden", null, null, null)).containsExactly("Next week");
		assertThat(titles("list", null, "#BILLS", null, null, null)).containsExactly("Overdue bill #bills");
		assertThat(titles("list", null, null, "2,3", null, null)).containsExactly("Overdue bill #bills", "Someday");
		assertThat(codeOf(() -> titles("list", null, null, "5", null, null))).isEqualTo(ErrorCode.BAD_REQUEST);
		assertThat(codeOf(() -> titles("list", "NOPE", null, null, null, null))).isEqualTo(ErrorCode.NOT_FOUND);
		assertThat(codeOf(() -> titles("week", null, null, null, null, null))).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void searchMatchesWordPrefixesInTitlesNotesAndTags() {
		assertThat(titles("search", null, null, null, null, "quart cafe")).containsExactly("Report");
		assertThat(titles("search", null, null, null, null, "rose")).containsExactly("Next week");
		assertThat(codeOf(() -> titles("search", null, null, null, null, " "))).isEqualTo(ErrorCode.BAD_REQUEST);
	}

	@Test
	void completedListsClosedTasksNewestFirst() throws Exception {
		List<Task> open = this.fx.tasks.query("list", this.home.id(), null, null, null, null, null, null, null, null,
				null).tasks();
		this.fx.tasks.complete(open.get(0).id(), null, TestVault.ALICE, TaskFixture.CLIENT);
		this.fx.vault.clock.advance(Duration.ofMinutes(1));
		this.fx.tasks.complete(open.get(1).id(), null, TestVault.ALICE, TaskFixture.CLIENT);
		this.fx.vault.clock.advance(Duration.ofMinutes(1));
		this.fx.tasks.update(open.get(2).id(),
				new UpdateTaskRequest(TaskFixture.json("{\"status\": \"cancelled\"}"), null), TestVault.ALICE,
				TaskFixture.CLIENT);
		TasksResponse completed = this.fx.tasks.query("completed", null, null, null, null, null, null, null, null, 2,
				null);
		assertThat(completed.total()).isEqualTo(3);
		assertThat(completed.tasks()).extracting(Task::id).containsExactly(open.get(2).id(), open.get(1).id());
		assertThat(completed.tasks().get(0).completedAt()).isNotNull();
		TasksResponse older = this.fx.tasks.query("completed", null, null, null, null, null, null, null, null, 2,
				completed.tasks().get(1).completedAt().toString());
		assertThat(older.tasks()).extracting(Task::id).containsExactly(open.get(0).id());
		// Closed tasks leave Today and the default list view.
		assertThat(titles("list", this.home.id(), null, null, null, null)).hasSize(3);
		assertThat(titles("list", this.home.id(), null, null, "all", null)).hasSize(6);
	}

	@Test
	void archivedListsAreLeftOutOfTodayButKeptInTheirOwnView() throws Exception {
		this.fx.lists.update(this.work.id(), new UpdateTaskRequest(TaskFixture.json("{\"archived\": true}"), null),
				TestVault.ALICE, TaskFixture.CLIENT);
		assertThat(titles("upcoming", null, null, null, null, null)).doesNotContain("Report");
		assertThat(titles("list", null, null, null, null, null)).doesNotContain("Report", "Someday");
		assertThat(titles("list", this.work.id(), null, null, null, null)).containsExactly("Report", "Someday");
		TasksResponse response = this.fx.tasks.query("list", null, null, null, null, null, null, null, null, null,
				null);
		assertThat(response.lists()).extracting(TaskList::name).containsExactly("Home", "Work");
		assertThat(response.lists().get(1).archived()).isTrue();
	}

	@Test
	void completingUsesTheClientsDayForRecurrence() throws Exception {
		Task daily = task(this.home, "Stretch", "\"due\": \"2026-10-16\", \"recurrence\": {\"rrule\": \"FREQ=DAILY\"}");
		// At 2026-10-16T12:00Z it is already the 17th in Auckland: today's occurrence is past there.
		Task next = this.fx.tasks.complete(daily.id(), new CompleteTaskRequest("Pacific/Auckland", null, null),
				TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(next.due()).isEqualTo("2026-10-18");
		Task again = this.fx.tasks.complete(daily.id(), new CompleteTaskRequest("America/Los_Angeles", null, null),
				TestVault.ALICE, TaskFixture.CLIENT).task();
		assertThat(again.due()).isEqualTo("2026-10-19");
	}

}
