package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.ReorderTasksRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskListWriteResult;
import com.rjgehan.notes.api.dto.TaskRecurrence;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.api.dto.TaskWriteResult;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.TaskDeletedEvent;
import com.rjgehan.notes.events.TaskEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.tasks.TaskCodec.Field;
import com.rjgehan.notes.vault.ApiPath;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Task operations (API.md §20, DESIGN §5.20). The server owns them, so two devices that change different tasks of one
 * list never conflict: each operation finds its task in the {@link TaskCatalog}, then re-reads the list file from
 * disk under the file's lock, changes single fields of single tasks, and writes the file back atomically. A change to
 * a field someone else changed since the client read it is a {@code 409 task-conflict}; repeating a change that is
 * already in place is a no-op, so retries are safe.
 */
@Service
public class TaskService {

	private static final Logger logger = LoggerFactory.getLogger(TaskService.class);

	/** Where tasks go when a request names no list; created on first use. */
	static final String INBOX = "Tasks/Inbox.tasks";

	/** How often an operation looks its task up again when the task moved between the lookup and the lock. */
	private static final int ATTEMPTS = 5;

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	private final TaskStore store;

	private final TaskWrites writes;

	private final TaskListService lists;

	public TaskService(TaskStore store, TaskWrites writes, TaskListService lists) {
		this.store = store;
		this.writes = writes;
		this.lists = lists;
	}

	/** One attempt of an operation; null means "the file changed under us, look the task up again". */
	@FunctionalInterface
	private interface Attempt<T> {

		@Nullable T run(TaskCatalog catalog) throws IOException;

	}

	// ---------------------------------------------------------------- reads

	/** {@code GET /api/tasks}; the parameters are those of {@link TaskQuery#of}. */
	public TasksResponse query(@Nullable String view, @Nullable String list, @Nullable String tag,
			@Nullable String priority, @Nullable String status, @Nullable String q, @Nullable String date,
			@Nullable String tz, @Nullable Integer days, @Nullable Integer limit, @Nullable String before) {
		TaskQuery query = TaskQuery.of(view, list, tag, priority, status, q, date, tz, days, limit, before,
				this.writes.clock());
		return query.run(this.store.catalog());
	}

	public Task get(String id) {
		return this.store.catalog().requireTask(id).task();
	}

	/**
	 * The tasks whose reminders may fire (ROADMAP item 9): open, not archived, in a list that is not archived, with at
	 * least one reminder.
	 */
	public List<Task> withReminders() {
		TaskCatalog catalog = this.store.catalog();
		List<Task> found = new ArrayList<>();
		for (TaskCatalog.Located located : catalog.tasks()) {
			Task task = located.task();
			if (task.reminders().isEmpty() || task.archived() || task.status().isClosed()) {
				continue;
			}
			TaskList list = catalog.list(task.listId());
			if (list != null && !list.archived()) {
				found.add(task);
			}
		}
		return found;
	}

	/** The task with this id, or null. */
	public @Nullable Task find(String id) {
		TaskCatalog.Located located = this.store.catalog().task(id);
		return (located != null) ? located.task() : null;
	}

	// ---------------------------------------------------------------- create

	/**
	 * {@code POST /api/tasks}. Without {@code listId} the task goes to its parent's list, or to the Inbox. Without
	 * {@code after} it goes last among its siblings; with {@code after: null} first; otherwise right after that task.
	 */
	public TaskWriteResult create(@Nullable JsonNode body, Identity identity, @Nullable String origin)
			throws IOException {
		if (body == null || !body.isObject()) {
			throw NotesException.badRequest("The body must be a task object");
		}
		List<FieldError> errors = new ArrayList<>();
		Map<Field, JsonNode> fields = TaskCodec.fields(body, "task", errors);
		if (!body.has("title")) {
			errors.add(new FieldError("task.title", "is required"));
		}
		boolean last = !body.has("after");
		String after = optionalId(body.get("after"), "after", errors);
		requireValid(errors);
		Author author = Author.of(identity);
		// The Inbox, when this request creates it: the caller gets no echo of its list.changed or folder.created.
		List<TaskList> createdLists = new ArrayList<>();
		Set<String> createdFolders = new LinkedHashSet<>();
		return attempt((catalog) -> {
			String listId = listFor(fields, catalog);
			if (listId == null) {
				TaskListWriteResult inbox = this.lists.ensureInbox(identity, origin);
				if (inbox != null) {
					createdLists.addAll(inbox.lists());
					createdFolders.addAll(inbox.createdFolders());
				}
				return null;
			}
			TaskList list = catalog.requireList(listId);
			ApiPath path = writablePath(catalog, list.path());
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				TaskFile file = session.require(path);
				if (file.isArchive() || !file.listId().equals(listId)) {
					return null;
				}
				TaskTree tree = new TaskTree(file);
				String parentId = textOrNull(fields.get(Field.PARENT_ID));
				String sectionId = textOrNull(fields.get(Field.SECTION_ID));
				checkParent(tree, null, parentId, 1, listId);
				checkSection(file, sectionId);
				ObjectNode node = NODES.objectNode();
				String id = this.writes.newId();
				node.put("id", id);
				node.put("status", TaskStatus.OPEN.wireName());
				node.put("priority", 0);
				node.putArray("tags");
				node.putArray("links");
				fields.forEach((field, value) -> TaskCodec.apply(node, field, value));
				String now = this.writes.now().toString();
				node.put("createdAt", now);
				node.put("updatedAt", now);
				if (!TaskStatus.OPEN.wireName().equals(node.path("status").stringValue())) {
					node.put("completedAt", now);
				}
				List<ObjectNode> siblings = tree.siblings(parentId, sectionId, Set.of());
				if (after != null && siblings.stream().noneMatch((sibling) -> TaskTree.id(sibling).equals(after))) {
					throw invalid("after", "is not a task in that place");
				}
				List<ObjectNode> renumbered = place(siblings, List.of(node), after, last);
				file.addTask(node);
				session.touch(file);
				Task task = view(node, file, path);
				session.publish(TaskEvent.created(task, origin));
				List<Task> changed = publishChanged(session, renumbered, file, path);
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK create {} in {} client={}", id, path.nfc(), origin);
				createdFolders.addAll(committed.createdFolders());
				List<TaskList> lists = createdLists.stream()
					.map((created) -> created.id().equals(listId) ? list : created)
					.toList();
				return new TaskWriteResult(task, changed, List.of(), false, committed.files(),
						List.copyOf(createdFolders), lists);
			}
		});
	}

	/** The list a new task goes to: the given one, its parent's, or the Inbox; null when the Inbox must be made. */
	private @Nullable String listFor(Map<Field, JsonNode> fields, TaskCatalog catalog) {
		JsonNode listId = fields.get(Field.LIST_ID);
		if (listId != null) {
			return listId.stringValue();
		}
		String parentId = textOrNull(fields.get(Field.PARENT_ID));
		if (parentId != null) {
			TaskCatalog.Located parent = catalog.task(parentId);
			if (parent == null || parent.task().archived()) {
				throw invalid("task.parentId", "is not an open list's task");
			}
			return parent.task().listId();
		}
		TaskList inbox = catalog.listAt(INBOX);
		if (inbox != null) {
			return inbox.id();
		}
		String blocked = catalog.blocked(INBOX);
		if (blocked != null) {
			throw TaskWrites.malformed(INBOX, blocked);
		}
		return null;
	}

	// ---------------------------------------------------------------- update

	/**
	 * {@code PATCH /api/tasks/{id}}: sets the fields in {@code changes}. A field whose server value differs both from
	 * the client's {@code base} and from the requested value was changed by someone else: {@code 409 task-conflict},
	 * nothing written. Changing {@code listId} moves the task with its subtasks to the end of the other list.
	 */
	public TaskWriteResult update(String id, @Nullable UpdateTaskRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		JsonNode changes = (request != null) ? request.changes() : null;
		JsonNode base = (request != null) ? request.base() : null;
		List<FieldError> errors = new ArrayList<>();
		if (changes == null || !changes.isObject()) {
			errors.add(new FieldError("changes", "must be an object"));
		}
		if (base != null && !base.isObject() && !base.isNull()) {
			errors.add(new FieldError("base", "must be an object"));
		}
		requireValid(errors);
		Map<Field, JsonNode> fields = TaskCodec.fields(changes, "changes", errors);
		requireValid(errors);
		Author author = Author.of(identity);
		return attempt((catalog) -> {
			TaskCatalog.Located located = catalog.requireTask(id);
			Task seen = located.task();
			JsonNode targetList = fields.get(Field.LIST_ID);
			boolean move = targetList != null && !targetList.stringValue().equals(seen.listId());
			if (seen.archived() && (fields.containsKey(Field.STATUS) || move || fields.containsKey(Field.PARENT_ID)
					|| fields.containsKey(Field.SECTION_ID))) {
				throw NotesException.badRequest(
						"An archived task's status, list, parent and section cannot change; uncomplete it first");
			}
			ApiPath source = writablePath(catalog, located.path());
			ApiPath target = move ? writablePath(catalog, catalog.requireList(targetList.stringValue()).path())
					: source;
			try (TaskWrites.Session session = this.writes.open(List.of(source, target), author, origin)) {
				TaskFile sourceFile = session.require(source);
				ObjectNode node = sourceFile.task(id);
				if (node == null) {
					return null;
				}
				Task current = view(node, sourceFile, source);
				checkBase(current, fields, base);
				Map<Field, JsonNode> effective = new LinkedHashMap<>();
				fields.forEach((field, value) -> {
					if (!TaskCodec.same(value, TaskCodec.apiValue(current, field))) {
						effective.put(field, value);
					}
				});
				if (effective.isEmpty()) {
					return unchanged(current);
				}
				TaskFile targetFile = sourceFile;
				if (effective.containsKey(Field.LIST_ID)) {
					targetFile = session.require(target);
					if (targetFile.isArchive() || !targetFile.listId().equals(targetList.stringValue())) {
						return null;
					}
				}
				List<ObjectNode> touched = new ArrayList<>();
				Set<String> movedIds = new LinkedHashSet<>();
				if (targetFile != sourceFile) {
					movedIds.addAll(moveSubtree(session, sourceFile, targetFile, node, effective, touched));
				}
				else {
					reparent(sourceFile, node, effective, touched);
					checkSection(sourceFile, textOrNull(effective.get(Field.SECTION_ID)),
							effective.containsKey(Field.SECTION_ID));
				}
				String now = this.writes.now().toString();
				applyFields(node, effective, current.status(), now);
				session.touch(targetFile);
				ApiPath written = (targetFile == sourceFile) ? source : target;
				Task task = view(node, targetFile, written);
				session.publish(TaskEvent.changed(task, origin));
				List<Task> changed = new ArrayList<>();
				for (String movedId : movedIds) {
					ObjectNode moved = targetFile.task(movedId);
					if (moved != null && moved != node) {
						Task movedTask = view(moved, targetFile, written);
						changed.add(movedTask);
						session.publish(TaskEvent.changed(movedTask, origin));
					}
				}
				changed.addAll(publishChanged(session, touched, targetFile, written));
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK update {} {} client={}", id, effective.keySet(), origin);
				return new TaskWriteResult(task, changed, List.of(), false, committed.files(),
						committed.createdFolders(), List.of());
			}
		});
	}

	/**
	 * Moves a task and its subtasks to another list file: the task goes last among the target's top-level tasks (or
	 * under the requested parent), sections are dropped (they belong to the old list) unless one is requested.
	 * Returns the ids moved.
	 */
	private List<String> moveSubtree(TaskWrites.Session session, TaskFile from, TaskFile to, ObjectNode node,
			Map<Field, JsonNode> fields, List<ObjectNode> touched) {
		TaskTree sourceTree = new TaskTree(from);
		String id = TaskTree.id(node);
		List<String> ids = new ArrayList<>();
		ids.add(id);
		ids.addAll(sourceTree.descendants(id));
		TaskTree targetTree = new TaskTree(to);
		for (String moving : ids) {
			if (targetTree.node(moving) != null) {
				throw NotesException.badRequest("A task with id " + moving + " already exists in the other list");
			}
		}
		String parentId = textOrNull(fields.get(Field.PARENT_ID));
		checkParent(targetTree, null, parentId, sourceTree.height(id), to.listId());
		String sectionId = textOrNull(fields.get(Field.SECTION_ID));
		checkSection(to, sectionId);
		for (String moving : ids) {
			ObjectNode moved = from.removeTask(moving);
			if (moved != null) {
				if (!moving.equals(id)) {
					moved.remove("sectionId");
				}
				to.addTask(moved);
			}
		}
		node.remove("sectionId");
		node.remove("parentId");
		touched.addAll(place(targetTree.siblings(parentId, sectionId, Set.of()), List.of(node), null, true));
		session.touchLosing(from);
		return ids;
	}

	/**
	 * Validates a new parent within the same file and, when the parent or section changes, moves the task to the end
	 * of its new siblings.
	 */
	private void reparent(TaskFile file, ObjectNode node, Map<Field, JsonNode> fields, List<ObjectNode> touched) {
		if (!fields.containsKey(Field.PARENT_ID)) {
			return;
		}
		TaskTree tree = new TaskTree(file);
		String id = TaskTree.id(node);
		String parentId = textOrNull(fields.get(Field.PARENT_ID));
		checkParent(tree, id, parentId, tree.height(id), file.listId());
		String sectionId = (parentId == null) ? sectionAfter(node, fields) : null;
		touched.addAll(place(tree.siblings(parentId, sectionId, Set.of(id)), List.of(node), null, true));
	}

	private static @Nullable String sectionAfter(ObjectNode node, Map<Field, JsonNode> fields) {
		return fields.containsKey(Field.SECTION_ID) ? textOrNull(fields.get(Field.SECTION_ID)) : TaskTree.section(node);
	}

	/** Writes the fields, keeps {@code completedAt} in line with the status, and stamps {@code updatedAt}. */
	private static void applyFields(ObjectNode node, Map<Field, JsonNode> fields, TaskStatus before, String now) {
		fields.forEach((field, value) -> TaskCodec.apply(node, field, value));
		JsonNode status = fields.get(Field.STATUS);
		if (status != null) {
			boolean closed = !status.stringValue().equals(TaskStatus.OPEN.wireName());
			if (closed && !before.isClosed()) {
				node.put("completedAt", now);
			}
			else if (!closed) {
				node.remove("completedAt");
			}
		}
		node.put("updatedAt", now);
	}

	// ---------------------------------------------------------------- complete and uncomplete

	/**
	 * {@code POST /api/tasks/{id}/complete}. A recurring task rolls forward to its next occurrence and stays open (its
	 * closed subtasks reopen); otherwise the task and its open subtasks become done. When the client's {@code base}
	 * shows a {@code due} or {@code start} the task no longer has, the occurrence was already completed (a retry, or
	 * another device), and nothing changes.
	 */
	public TaskWriteResult complete(String id, @Nullable CompleteTaskRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		LocalDate today = TaskQuery.today((request != null) ? request.date() : null,
				(request != null) ? request.tz() : null, this.writes.clock());
		LocalDate day = (today != null) ? today : this.writes.clock().instant().atZone(ZoneOffset.UTC).toLocalDate();
		JsonNode base = (request != null) ? request.base() : null;
		if (base != null && !base.isObject() && !base.isNull()) {
			throw invalid("base", "must be an object");
		}
		Author author = Author.of(identity);
		return attempt((catalog) -> {
			TaskCatalog.Located located = catalog.requireTask(id);
			if (located.task().status().isClosed()) {
				return unchanged(located.task());
			}
			ApiPath path = writablePath(catalog, located.path());
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				TaskFile file = session.require(path);
				ObjectNode node = file.task(id);
				if (node == null) {
					return null;
				}
				Task current = view(node, file, path);
				if (current.status().isClosed() || !matchesBase(current, base)) {
					return unchanged(current);
				}
				String now = this.writes.now().toString();
				Recurrence.Next next = next(current, day);
				if (next != null) {
					rollForward(node, current, next, day);
				}
				else {
					node.put("status", TaskStatus.DONE.wireName());
					node.put("completedAt", now);
				}
				List<ObjectNode> touched = cascade(new TaskTree(file), id, next != null, now);
				node.put("updatedAt", now);
				session.touch(file);
				Task task = view(node, file, path);
				session.publish(TaskEvent.changed(task, origin));
				List<Task> changed = publishChanged(session, touched, file, path);
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK complete {} rolled={} client={}", id, next != null, origin);
				return new TaskWriteResult(task, changed, List.of(), next != null, committed.files(),
						committed.createdFolders(), List.of());
			}
		});
	}

	/**
	 * The subtasks of {@code id} that follow it: when it rolls forward ({@code reopen}) its closed subtasks reopen for
	 * the next occurrence; when it is done, its open subtasks are done too. Returns the subtasks changed.
	 */
	private static List<ObjectNode> cascade(TaskTree tree, String id, boolean reopen, String now) {
		List<ObjectNode> touched = new ArrayList<>();
		for (String child : tree.descendants(id)) {
			ObjectNode subtask = tree.node(child);
			if (subtask == null || isOpen(subtask) == reopen) {
				continue;
			}
			if (reopen) {
				subtask.put("status", TaskStatus.OPEN.wireName());
				subtask.remove("completedAt");
			}
			else {
				subtask.put("status", TaskStatus.DONE.wireName());
				subtask.put("completedAt", now);
			}
			subtask.put("updatedAt", now);
			touched.add(subtask);
		}
		return touched;
	}

	private static boolean isOpen(ObjectNode node) {
		return TaskStatus.OPEN.wireName().equals(node.path("status").stringValue(TaskStatus.OPEN.wireName()));
	}

	private static Recurrence.@Nullable Next next(Task task, LocalDate day) {
		TaskRecurrence recurrence = task.recurrence();
		if (recurrence == null) {
			return null;
		}
		String anchor = (task.due() != null) ? task.due() : task.start();
		return Recurrence.next(recurrence.rrule(), recurrence.from(), anchor, day);
	}

	/**
	 * Moves the due date (or the start date, for a task without one) to the next occurrence, and the other date and
	 * the reminders by the same number of days, keeping their times.
	 */
	private static void rollForward(ObjectNode node, Task task, Recurrence.Next next, LocalDate day) {
		long shift;
		if (task.due() != null) {
			shift = ChronoUnit.DAYS.between(TaskDates.date(task.due()), TaskDates.date(next.value()));
			node.put("due", next.value());
			if (task.start() != null) {
				node.put("start", TaskDates.plusDays(task.start(), shift));
			}
		}
		else if (task.start() != null) {
			shift = ChronoUnit.DAYS.between(TaskDates.date(task.start()), TaskDates.date(next.value()));
			node.put("start", next.value());
		}
		else {
			shift = ChronoUnit.DAYS.between(day, TaskDates.date(next.value()));
			node.put("due", next.value());
		}
		// Shifted in place, so fields of a reminder this version does not know (ROADMAP item 9) survive.
		if (node.get("reminders") instanceof ArrayNode reminders) {
			for (JsonNode reminder : reminders) {
				String at = reminder.path("at").stringValue(null);
				if (reminder instanceof ObjectNode object && TaskDates.isDateTime(at)) {
					object.put("at", TaskDates.plusDays(at, shift));
				}
			}
		}
		if (node.get("recurrence") instanceof ObjectNode recurrence) {
			recurrence.put("rrule", next.rrule());
		}
	}

	/**
	 * {@code POST /api/tasks/{id}/uncomplete}: reopens a done or cancelled task. A task already rolled into an archive
	 * file moves back into its list, with its archived subtasks.
	 */
	public TaskWriteResult uncomplete(String id, Identity identity, @Nullable String origin) throws IOException {
		Author author = Author.of(identity);
		return attempt((catalog) -> {
			TaskCatalog.Located located = catalog.requireTask(id);
			if (!located.task().status().isClosed()) {
				return unchanged(located.task());
			}
			ApiPath path = writablePath(catalog, located.path());
			ApiPath target = path;
			if (located.task().archived()) {
				TaskList list = catalog.list(located.task().listId());
				if (list == null) {
					throw new NotesException(ErrorCode.NOT_FOUND,
							"The list of this archived task no longer exists, so it cannot be reopened");
				}
				target = writablePath(catalog, list.path());
			}
			try (TaskWrites.Session session = this.writes.open(List.of(path, target), author, origin)) {
				TaskFile file = session.require(path);
				ObjectNode node = file.task(id);
				if (node == null) {
					return null;
				}
				if (isOpen(node)) {
					return unchanged(view(node, file, path));
				}
				TaskFile targetFile = file;
				List<String> moved = new ArrayList<>();
				if (target != path) {
					targetFile = session.require(target);
					if (targetFile.isArchive() || !targetFile.listId().equals(file.listId())) {
						return null;
					}
					moved.addAll(restoreFromArchive(session, file, targetFile, node));
				}
				String now = this.writes.now().toString();
				node.put("status", TaskStatus.OPEN.wireName());
				node.remove("completedAt");
				node.put("updatedAt", now);
				session.touch(targetFile);
				ApiPath written = (targetFile == file) ? path : target;
				Task task = view(node, targetFile, written);
				session.publish(TaskEvent.changed(task, origin));
				List<Task> changed = new ArrayList<>();
				for (String other : moved) {
					ObjectNode restored = targetFile.task(other);
					if (restored != null && restored != node) {
						Task restoredTask = view(restored, targetFile, written);
						changed.add(restoredTask);
						session.publish(TaskEvent.changed(restoredTask, origin));
					}
				}
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK uncomplete {} client={}", id, origin);
				return new TaskWriteResult(task, changed, List.of(), false, committed.files(),
						committed.createdFolders(), List.of());
			}
		});
	}

	/** Moves an archived task and its archived subtasks back into the list file; returns their ids. */
	private List<String> restoreFromArchive(TaskWrites.Session session, TaskFile archive, TaskFile list,
			ObjectNode node) {
		TaskTree archiveTree = new TaskTree(archive);
		TaskTree listTree = new TaskTree(list);
		String id = TaskTree.id(node);
		List<String> ids = new ArrayList<>();
		ids.add(id);
		ids.addAll(archiveTree.descendants(id));
		for (String moving : ids) {
			if (listTree.node(moving) != null) {
				throw NotesException.badRequest("A task with id " + moving + " already exists in the list");
			}
		}
		String parentId = node.path("parentId").stringValue(null);
		if (parentId != null && listTree.node(parentId) == null) {
			node.remove("parentId");
		}
		String sectionId = TaskTree.section(node);
		if (sectionId != null && !hasSection(list, sectionId)) {
			node.remove("sectionId");
		}
		for (String moving : ids) {
			ObjectNode restored = archive.removeTask(moving);
			if (restored != null) {
				list.addTask(restored);
			}
		}
		session.touchLosing(archive);
		return ids;
	}

	// ---------------------------------------------------------------- reorder and delete

	/**
	 * {@code POST /api/tasks/reorder}: places tasks of one list, in the given order, right after {@code after} (or
	 * first) under {@code parentId} and, at the top level, in {@code sectionId}. Only the moved tasks get new order
	 * keys, unless the neighbours' keys are unusable (a hand edit); then the whole sibling sequence is renumbered.
	 */
	public TaskWriteResult reorder(@Nullable ReorderTasksRequest request, Identity identity, @Nullable String origin)
			throws IOException {
		if (request == null || request.listId() == null || request.ids() == null || request.ids().isEmpty()) {
			throw NotesException.badRequest("listId and a non-empty ids are required");
		}
		List<FieldError> errors = new ArrayList<>();
		Set<String> ids = new LinkedHashSet<>();
		for (String id : request.ids()) {
			if (id == null || !TaskFile.ID.matcher(id).matches() || !ids.add(id)) {
				errors.add(new FieldError("ids", "must be distinct task ids"));
				break;
			}
		}
		if (request.after() != null && ids.contains(request.after())) {
			errors.add(new FieldError("after", "cannot be one of the moved tasks"));
		}
		requireValid(errors);
		Author author = Author.of(identity);
		return attempt((catalog) -> {
			TaskList list = catalog.requireList(request.listId());
			for (String id : ids) {
				TaskCatalog.Located located = catalog.requireTask(id);
				if (!located.task().listId().equals(list.id()) || located.task().archived()) {
					throw NotesException.badRequest("Every task must be an active task of list " + list.id());
				}
			}
			ApiPath path = writablePath(catalog, list.path());
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				TaskFile file = session.require(path);
				if (file.isArchive() || !file.listId().equals(list.id())) {
					return null;
				}
				TaskTree tree = new TaskTree(file);
				List<ObjectNode> moving = new ArrayList<>();
				for (String id : ids) {
					ObjectNode node = tree.node(id);
					if (node == null) {
						return null;
					}
					moving.add(node);
				}
				String parentId = request.parentId();
				for (String id : ids) {
					checkParent(tree, id, parentId, tree.height(id), list.id());
				}
				String sectionId = (parentId == null) ? request.sectionId() : null;
				checkSection(file, sectionId);
				List<ObjectNode> siblings = tree.siblings(parentId, sectionId, ids);
				if (request.after() != null
						&& siblings.stream().noneMatch((s) -> TaskTree.id(s).equals(request.after()))) {
					throw invalid("after", "is not a task in that place");
				}
				if (alreadyPlaced(tree, siblings, moving, parentId, sectionId, request.after())) {
					// A retry, or a drop where the tasks already were.
					return new TaskWriteResult(null, viewAll(moving, file, path), List.of(), false, List.of(),
							List.of(), List.of());
				}
				for (ObjectNode node : moving) {
					if (parentId != null) {
						node.put("parentId", parentId);
					}
					else {
						node.remove("parentId");
						if (sectionId != null) {
							node.put("sectionId", sectionId);
						}
						else {
							node.remove("sectionId");
						}
					}
				}
				List<ObjectNode> touched = new ArrayList<>(moving);
				touched.addAll(place(siblings, moving, request.after(), false));
				String now = this.writes.now().toString();
				touched.forEach((node) -> node.put("updatedAt", now));
				session.touch(file);
				List<Task> changed = publishChanged(session, touched, file, path);
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK reorder {} in {} client={}", ids, path.nfc(), origin);
				return new TaskWriteResult(null, changed, List.of(), false, committed.files(),
						committed.createdFolders(), List.of());
			}
		});
	}

	/** True when the tasks already sit, in this order, right after {@code afterId} in that place. */
	private static boolean alreadyPlaced(TaskTree tree, List<ObjectNode> siblings, List<ObjectNode> moving,
			@Nullable String parentId, @Nullable String sectionId, @Nullable String afterId) {
		int index = 0;
		if (afterId != null) {
			for (int i = 0; i < siblings.size(); i++) {
				if (TaskTree.id(siblings.get(i)).equals(afterId)) {
					index = i + 1;
				}
			}
		}
		String previous = (index > 0) ? TaskTree.order(siblings.get(index - 1)) : null;
		for (ObjectNode node : moving) {
			String key = TaskTree.order(node);
			boolean samePlace = Objects.equals(tree.parentOf(node), parentId)
					&& (parentId != null || Objects.equals(TaskTree.section(node), sectionId));
			if (!samePlace || !FractionalIndex.isValid(key) || (previous != null && key.compareTo(previous) <= 0)) {
				return false;
			}
			previous = key;
		}
		return index >= siblings.size() || previous.compareTo(TaskTree.order(siblings.get(index))) < 0;
	}

	/** {@code DELETE /api/tasks/{id}}: removes the task and its subtasks. */
	public TaskWriteResult delete(String id, Identity identity, @Nullable String origin) throws IOException {
		Author author = Author.of(identity);
		return attempt((catalog) -> {
			TaskCatalog.Located located = catalog.requireTask(id);
			ApiPath path = writablePath(catalog, located.path());
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				TaskFile file = session.require(path);
				if (file.task(id) == null) {
					return null;
				}
				TaskTree tree = new TaskTree(file);
				List<String> deleted = new ArrayList<>();
				deleted.add(id);
				deleted.addAll(tree.descendants(id));
				for (String gone : deleted) {
					file.removeTask(gone);
					session.publish(new TaskDeletedEvent(gone, file.listId(), origin));
				}
				session.touchLosing(file);
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASK delete {} (+{} subtasks) client={}", id, deleted.size() - 1, origin);
				return new TaskWriteResult(null, List.of(), List.copyOf(deleted), false, committed.files(),
						committed.createdFolders(), List.of());
			}
		});
	}

	// ---------------------------------------------------------------- helpers

	private <T> T attempt(Attempt<T> attempt) throws IOException {
		for (int i = 0; i < ATTEMPTS; i++) {
			T result = attempt.run(this.store.catalog());
			if (result != null) {
				return result;
			}
		}
		// The task kept moving between files while this request looked for it.
		throw NotesException.busy();
	}

	/** The path of a file the task API may write; {@code 409 malformed-file} when it is blocked. */
	private ApiPath writablePath(TaskCatalog catalog, String path) {
		String blocked = catalog.blocked(path);
		if (blocked != null) {
			throw TaskWrites.malformed(path, blocked);
		}
		return this.writes.existing(path);
	}

	/** A task node as the API shows it; a task the server cannot read is {@code 409 malformed-file}. */
	static Task view(ObjectNode node, TaskFile file, ApiPath path) {
		TaskCodec.ReadTask read = TaskCodec.readTask(node, file.listId(), file.isArchive());
		if (read.task() == null) {
			throw TaskWrites.malformed(path.nfc(), "task " + TaskTree.id(node) + ": " + read.problems().get(0));
		}
		return read.task();
	}

	private static List<Task> viewAll(List<ObjectNode> nodes, TaskFile file, ApiPath path) {
		List<Task> tasks = new ArrayList<>();
		nodes.forEach((node) -> tasks.add(view(node, file, path)));
		return tasks;
	}

	/** Announces {@code task.changed} for each node and returns the tasks. */
	private static List<Task> publishChanged(TaskWrites.Session session, List<ObjectNode> nodes, TaskFile file,
			ApiPath path) {
		List<Task> tasks = new ArrayList<>();
		Set<String> seen = new HashSet<>();
		for (ObjectNode node : nodes) {
			if (seen.add(TaskTree.id(node))) {
				Task task = view(node, file, path);
				tasks.add(task);
				session.publish(TaskEvent.changed(task, session.origin()));
			}
		}
		return tasks;
	}

	private static TaskWriteResult unchanged(Task task) {
		return new TaskWriteResult(task, List.of(), List.of(), false, List.of(), List.of(), List.of());
	}

	/**
	 * Sets the order key of {@code moving} (in order) so they sit right after {@code afterId} among
	 * {@code siblings} (first when it is null, last when {@code last}). Returns the siblings that had to be renumbered.
	 */
	static List<ObjectNode> place(List<ObjectNode> siblings, List<ObjectNode> moving, @Nullable String afterId,
			boolean last) {
		int index = 0;
		if (last) {
			index = siblings.size();
		}
		else if (afterId != null) {
			for (int i = 0; i < siblings.size(); i++) {
				if (TaskTree.id(siblings.get(i)).equals(afterId)) {
					index = i + 1;
					break;
				}
			}
		}
		String previous = (index > 0) ? TaskTree.order(siblings.get(index - 1)) : null;
		String next = (index < siblings.size()) ? TaskTree.order(siblings.get(index)) : null;
		List<String> keys = TaskOrder.keysBetween(previous, next, moving.size());
		if (keys != null) {
			for (int i = 0; i < moving.size(); i++) {
				moving.get(i).put("order", keys.get(i));
			}
			return List.of();
		}
		List<ObjectNode> sequence = new ArrayList<>(siblings.subList(0, index));
		sequence.addAll(moving);
		sequence.addAll(siblings.subList(index, siblings.size()));
		List<String> fresh = TaskOrder.renumber(sequence.size());
		List<ObjectNode> renumbered = new ArrayList<>();
		for (int i = 0; i < sequence.size(); i++) {
			ObjectNode node = sequence.get(i);
			if (!fresh.get(i).equals(TaskTree.order(node))) {
				node.put("order", fresh.get(i));
				if (!moving.contains(node)) {
					renumbered.add(node);
				}
			}
		}
		return renumbered;
	}

	/**
	 * A parent must be another task of the same file, not the task itself or one of its subtasks, and the task's
	 * subtree ({@code height} levels) must fit under it within {@link TaskTree#MAX_DEPTH}.
	 */
	private static void checkParent(TaskTree tree, @Nullable String id, @Nullable String parentId, int height,
			String listId) {
		if (parentId == null) {
			return;
		}
		if (tree.node(parentId) == null) {
			throw invalid("parentId", "is not a task of list " + listId);
		}
		if (id != null && (parentId.equals(id) || tree.descendants(id).contains(parentId))) {
			throw invalid("parentId", "cannot be the task itself or one of its subtasks");
		}
		if (tree.depth(parentId) + height > TaskTree.MAX_DEPTH) {
			throw invalid("parentId", "subtasks can be at most " + TaskTree.MAX_DEPTH + " levels deep");
		}
	}

	private static void checkSection(TaskFile file, @Nullable String sectionId) {
		checkSection(file, sectionId, true);
	}

	private static void checkSection(TaskFile file, @Nullable String sectionId, boolean given) {
		if (given && sectionId != null && !hasSection(file, sectionId)) {
			throw invalid("sectionId", "is not a section of list " + file.listId());
		}
	}

	static boolean hasSection(TaskFile file, String sectionId) {
		for (JsonNode section : file.list().path("sections")) {
			if (sectionId.equals(section.path("id").stringValue(null))) {
				return true;
			}
		}
		return false;
	}

	/** The {@code 409 task-conflict} check of {@link #update}. */
	private static void checkBase(Task current, Map<Field, JsonNode> fields, @Nullable JsonNode base) {
		if (base == null || base.isNull()) {
			return;
		}
		List<String> conflicting = new ArrayList<>();
		fields.forEach((field, value) -> {
			JsonNode seen = base.get(field.json);
			JsonNode now = TaskCodec.apiValue(current, field);
			if (seen != null && !TaskCodec.same(seen, now) && !TaskCodec.same(value, now)) {
				conflicting.add(field.json);
			}
		});
		if (!conflicting.isEmpty()) {
			throw new NotesException(ErrorCode.TASK_CONFLICT,
					"The task changed on the server: " + String.join(", ", conflicting),
					Map.of("task", current, "fields", conflicting));
		}
	}

	/** False when the client's {@code base} shows a {@code due} or {@code start} the task no longer has. */
	private static boolean matchesBase(Task current, @Nullable JsonNode base) {
		if (base == null || base.isNull()) {
			return true;
		}
		for (Field field : List.of(Field.DUE, Field.START)) {
			JsonNode seen = base.get(field.json);
			if (seen != null && !TaskCodec.same(seen, TaskCodec.apiValue(current, field))) {
				return false;
			}
		}
		return true;
	}

	private static @Nullable String optionalId(@Nullable JsonNode value, String field, List<FieldError> errors) {
		if (value == null || value.isNull()) {
			return null;
		}
		if (!value.isString() || !TaskFile.ID.matcher(value.stringValue()).matches()) {
			errors.add(new FieldError(field, "must be null or a task id"));
			return null;
		}
		return value.stringValue();
	}

	private static @Nullable String textOrNull(@Nullable JsonNode value) {
		return (value != null && value.isString()) ? value.stringValue() : null;
	}

	static NotesException invalid(String field, String message) {
		List<FieldError> errors = List.of(new FieldError(field, message));
		return new NotesException(ErrorCode.BAD_REQUEST, field + " " + message, Map.of("errors", errors));
	}

	static void requireValid(List<FieldError> errors) {
		if (!errors.isEmpty()) {
			FieldError first = errors.get(0);
			throw new NotesException(ErrorCode.BAD_REQUEST, first.field() + " " + first.message(),
					Map.of("errors", List.copyOf(errors)));
		}
	}

}
