package com.rjgehan.notes.tasks;

import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.api.dto.TaskView;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.Tokenizer;
import org.jspecify.annotations.Nullable;

/**
 * {@code GET /api/tasks} (API.md §20.1): one view of the catalog, with optional list, tag and priority filters.
 * "Today" and "Upcoming" depend on the client's date, which it sends as {@code date} or as its time zone {@code tz}.
 *
 * @param view which tasks
 * @param listId only this list
 * @param tag only tasks with this tag or a nested one ({@code a} matches {@code a/b}), from {@code tags} or inline in
 * the title
 * @param priorities only these priorities (empty: any)
 * @param statuses only these statuses (null: the view's default)
 * @param query the search words ({@code search} only)
 * @param today the client's date ({@code today} and {@code upcoming})
 * @param days how many days {@code upcoming} covers, today included
 * @param limit at most this many tasks ({@code completed} and {@code search})
 * @param before only tasks completed before this instant ({@code completed}, for paging)
 */
record TaskQuery(TaskView view, @Nullable String listId, @Nullable String tag, Set<Integer> priorities,
		@Nullable Set<TaskStatus> statuses, @Nullable String query, @Nullable LocalDate today, int days, int limit,
		@Nullable Instant before) {

	static final int DEFAULT_DAYS = 14;

	static final int MAX_DAYS = 366;

	static final int DEFAULT_LIMIT = 200;

	static final int MAX_LIMIT = 1000;

	/** Validates the query parameters; {@code 400 bad-request} names the first bad one. */
	static TaskQuery of(@Nullable String view, @Nullable String list, @Nullable String tag,
			@Nullable String priority, @Nullable String status, @Nullable String q, @Nullable String date,
			@Nullable String tz, @Nullable Integer days, @Nullable Integer limit, @Nullable String before,
			Clock clock) {
		TaskView taskView = view(view);
		Set<Integer> priorities = new TreeSet<>();
		if (priority != null && !priority.isBlank()) {
			for (String value : priority.split(",")) {
				switch (value.strip()) {
					case "0", "1", "2", "3" -> priorities.add(Integer.parseInt(value.strip()));
					default -> throw NotesException.badRequest("priority must be a comma-separated list of 0 to 3");
				}
			}
		}
		Set<TaskStatus> statuses = null;
		if (status != null && !status.isBlank() && !status.equals("all")) {
			statuses = EnumSet.noneOf(TaskStatus.class);
			for (String value : status.split(",")) {
				statuses.add(switch (value.strip()) {
					case "open" -> TaskStatus.OPEN;
					case "done" -> TaskStatus.DONE;
					case "cancelled" -> TaskStatus.CANCELLED;
					default -> throw NotesException.badRequest("status must be all or a list of open, done, cancelled");
				});
			}
		}
		else if ("all".equals(status)) {
			statuses = EnumSet.allOf(TaskStatus.class);
		}
		String normalizedTag = (tag != null && !tag.isBlank()) ? tag.strip() : null;
		if (normalizedTag != null && normalizedTag.startsWith("#")) {
			normalizedTag = normalizedTag.substring(1);
		}
		LocalDate today = today(date, tz, clock);
		if ((taskView == TaskView.TODAY || taskView == TaskView.UPCOMING) && today == null) {
			throw NotesException.badRequest("today and upcoming need the client's date (date) or time zone (tz)");
		}
		int span = (days != null) ? days : DEFAULT_DAYS;
		if (span < 1 || span > MAX_DAYS) {
			throw NotesException.badRequest("days must be between 1 and " + MAX_DAYS);
		}
		int max = (limit != null) ? limit : DEFAULT_LIMIT;
		if (max < 1 || max > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		String search = (q != null && !q.isBlank()) ? q.strip() : null;
		if (taskView == TaskView.SEARCH && search == null) {
			throw NotesException.badRequest("search needs q");
		}
		Instant cutoff = null;
		if (before != null && !before.isBlank()) {
			try {
				cutoff = Instant.parse(before);
			}
			catch (DateTimeParseException ex) {
				throw NotesException.badRequest("before must be an ISO-8601 instant");
			}
		}
		return new TaskQuery(taskView, (list != null && !list.isBlank()) ? list : null, normalizedTag, priorities,
				statuses, search, today, span, max, cutoff);
	}

	/**
	 * The client's date: {@code date} (YYYY-MM-DD) when given, else today in the time zone {@code tz}, else null.
	 * @throws NotesException {@code 400} for an invalid date or an unknown time zone
	 */
	static @Nullable LocalDate today(@Nullable String date, @Nullable String tz, Clock clock) {
		if (date != null && !date.isBlank()) {
			if (!TaskDates.isDate(date)) {
				throw NotesException.badRequest("date must be YYYY-MM-DD");
			}
			return TaskDates.date(date);
		}
		if (tz != null && !tz.isBlank()) {
			try {
				return clock.instant().atZone(ZoneId.of(tz)).toLocalDate();
			}
			catch (DateTimeException ex) {
				throw NotesException.badRequest("tz must be an IANA time zone such as Europe/Paris");
			}
		}
		return null;
	}

	private static TaskView view(@Nullable String view) {
		if (view == null || view.isBlank()) {
			return TaskView.LIST;
		}
		return switch (view.toLowerCase(Locale.ROOT)) {
			case "today" -> TaskView.TODAY;
			case "upcoming" -> TaskView.UPCOMING;
			case "list" -> TaskView.LIST;
			case "completed" -> TaskView.COMPLETED;
			case "search" -> TaskView.SEARCH;
			default -> throw NotesException.badRequest("view must be today, upcoming, list, completed or search");
		};
	}

	TasksResponse run(TaskCatalog catalog) {
		if (this.listId != null) {
			catalog.requireList(this.listId);
		}
		Map<String, Integer> listOrder = new HashMap<>();
		for (TaskList list : catalog.lists()) {
			listOrder.put(list.id(), listOrder.size());
		}
		List<Task> matching = new ArrayList<>();
		for (TaskCatalog.Located located : catalog.tasks()) {
			Task task = located.task();
			if (inView(task, catalog) && matchesFilters(task)) {
				matching.add(task);
			}
		}
		matching.sort(order(listOrder));
		int total = matching.size();
		List<Task> page = (this.view == TaskView.COMPLETED || this.view == TaskView.SEARCH)
				? matching.subList(0, Math.min(this.limit, total)) : matching;
		return new TasksResponse(this.view, catalog.lists(), List.copyOf(page), total, catalog.problems());
	}

	private boolean inView(Task task, TaskCatalog catalog) {
		TaskList list = catalog.list(task.listId());
		boolean activeList = list != null && !list.archived() && !task.archived();
		Set<TaskStatus> wanted = (this.statuses != null) ? this.statuses : defaultStatuses();
		if (!wanted.contains(task.status())) {
			return false;
		}
		return switch (this.view) {
			case TODAY -> activeList && (onOrBefore(task.due()) || onOrBefore(task.start()));
			case UPCOMING -> {
				String when = (task.due() != null) ? task.due() : task.start();
				if (!activeList || when == null) {
					yield false;
				}
				LocalDate day = TaskDates.date(when);
				yield !day.isBefore(this.today) && day.isBefore(this.today.plusDays(this.days));
			}
			// One list (archived or not), or every list that is not archived; archive files are not lists.
			case LIST -> !task.archived() && list != null && ((this.listId != null) || !list.archived());
			case COMPLETED -> this.before == null
					|| (task.completedAt() != null && task.completedAt().isBefore(this.before));
			case SEARCH -> matchesSearch(task);
		};
	}

	private Set<TaskStatus> defaultStatuses() {
		return switch (this.view) {
			case COMPLETED -> EnumSet.of(TaskStatus.DONE, TaskStatus.CANCELLED);
			case SEARCH -> EnumSet.allOf(TaskStatus.class);
			default -> EnumSet.of(TaskStatus.OPEN);
		};
	}

	private boolean onOrBefore(@Nullable String value) {
		return value != null && !TaskDates.date(value).isAfter(this.today);
	}

	private boolean matchesFilters(Task task) {
		if (this.listId != null && !this.listId.equals(task.listId())) {
			return false;
		}
		if (!this.priorities.isEmpty() && !this.priorities.contains(task.priority())) {
			return false;
		}
		return this.tag == null || tags(task).stream().anyMatch((tag) -> isTagOrNested(tag, this.tag));
	}

	/** The task's tags: its {@code tags} and the {@code #tags} written in its title. */
	static List<String> tags(Task task) {
		List<String> tags = new ArrayList<>(task.tags());
		tags.addAll(MarkdownScanner.scanFragment(task.title()).distinctTags());
		return tags;
	}

	private static boolean isTagOrNested(String tag, String filter) {
		String lower = tag.toLowerCase(Locale.ROOT);
		String wanted = filter.toLowerCase(Locale.ROOT);
		return lower.equals(wanted) || lower.startsWith(wanted + "/");
	}

	/** Every word of the query starts a word of the title, the notes or a tag (case- and accent-insensitive). */
	private boolean matchesSearch(Task task) {
		List<String> words = Tokenizer.tokenize(this.query).stream().map(Tokenizer.Token::term).toList();
		if (words.isEmpty()) {
			return false;
		}
		StringBuilder text = new StringBuilder(task.title());
		if (task.notes() != null) {
			text.append('\n').append(task.notes());
		}
		task.tags().forEach((tag) -> text.append('\n').append(tag));
		List<String> terms = Tokenizer.tokenize(text.toString()).stream().map(Tokenizer.Token::term).toList();
		return words.stream().allMatch((word) -> terms.stream().anyMatch((term) -> term.startsWith(word)));
	}

	private Comparator<Task> order(Map<String, Integer> listOrder) {
		Comparator<Task> byList = Comparator.comparingInt((Task task) -> listOrder.getOrDefault(task.listId(),
				Integer.MAX_VALUE));
		return switch (this.view) {
			case TODAY, UPCOMING -> Comparator.comparing(TaskQuery::when, TaskQuery::compareWhen)
				.thenComparing(Comparator.comparingInt(Task::priority).reversed())
				.thenComparing(byList)
				.thenComparing(TaskOrder.TASKS);
			case LIST -> byList.thenComparing(TaskOrder.TASKS);
			case COMPLETED -> Comparator.comparing(Task::completedAt, Comparator.nullsLast(Comparator.reverseOrder()))
				.thenComparing(Task::id, Comparator.reverseOrder());
			case SEARCH -> Comparator.comparing((Task task) -> task.status().isClosed())
				.thenComparing(Task::updatedAt, Comparator.nullsLast(Comparator.reverseOrder()))
				.thenComparing(Task::id);
		};
	}

	/** The date a task is scheduled for: its due date, else its start date. */
	private static @Nullable String when(Task task) {
		return (task.due() != null) ? task.due() : task.start();
	}

	private static int compareWhen(@Nullable String a, @Nullable String b) {
		if (a == null || b == null) {
			return (a == null) ? ((b == null) ? 0 : 1) : -1;
		}
		return TaskDates.compare(a, b);
	}

}
