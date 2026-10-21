package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskFileProblem;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Every task list and task of the vault at one moment, built from the {@link TaskSnapshot}s of all {@code .tasks}
 * files in path order. Ids must be unique: a later list file that repeats a list id is reported and blocked (its
 * tasks are hidden, and the task API never writes it), and a task whose id was already seen is reported and hidden.
 * Nothing is rewritten to resolve this; the user decides which copy to keep.
 */
final class TaskCatalog {

	/** A task and the file it lives in. */
	record Located(Task task, String path) {
	}

	private final List<TaskList> lists;

	private final Map<String, TaskList> listsById;

	private final Map<String, Located> tasks;

	private final List<TaskFileProblem> problems;

	private final Map<String, TaskSnapshot> files;

	private final Map<String, String> blocked;

	private TaskCatalog(List<TaskList> lists, Map<String, TaskList> listsById, Map<String, Located> tasks,
			List<TaskFileProblem> problems, Map<String, TaskSnapshot> files, Map<String, String> blocked) {
		this.lists = lists;
		this.listsById = listsById;
		this.tasks = tasks;
		this.problems = problems;
		this.files = files;
		this.blocked = blocked;
	}

	static TaskCatalog of(List<TaskSnapshot> snapshots) {
		List<TaskSnapshot> ordered = new ArrayList<>(snapshots);
		ordered.sort(Comparator.comparing(TaskSnapshot::path));
		Map<String, TaskList> listsById = new LinkedHashMap<>();
		Map<String, Located> tasks = new LinkedHashMap<>();
		List<TaskFileProblem> problems = new ArrayList<>();
		Map<String, TaskSnapshot> files = new HashMap<>();
		Map<String, String> blocked = new HashMap<>();
		for (TaskSnapshot snapshot : ordered) {
			files.put(snapshot.path(), snapshot);
			problems.addAll(snapshot.problems());
			if (snapshot.blocked() != null) {
				blocked.put(snapshot.path(), snapshot.blocked());
			}
			TaskList list = snapshot.list();
			if (list != null) {
				TaskList first = listsById.get(list.id());
				if (first != null) {
					String reason = "repeats the list id of " + first.path() + "; its tasks are not shown";
					problems.add(new TaskFileProblem(snapshot.path(), null, reason));
					blocked.put(snapshot.path(), reason);
					continue;
				}
				listsById.put(list.id(), list);
			}
			if (snapshot.list() == null && !snapshot.archive()) {
				continue;
			}
			for (Task task : snapshot.tasks()) {
				Located first = tasks.get(task.id());
				if (first != null) {
					problems.add(new TaskFileProblem(snapshot.path(), task.id(),
							"repeats the task id of a task in " + first.path() + "; this copy is not shown"));
					continue;
				}
				tasks.put(task.id(), new Located(task, snapshot.path()));
			}
		}
		List<TaskList> lists = new ArrayList<>(listsById.values());
		lists.sort(TaskOrder.LISTS);
		return new TaskCatalog(List.copyOf(lists), listsById, tasks, List.copyOf(problems), files, blocked);
	}

	/** Every usable list, in list order (archived lists included). */
	List<TaskList> lists() {
		return this.lists;
	}

	@Nullable TaskList list(String id) {
		return this.listsById.get(id);
	}

	TaskList requireList(String id) {
		TaskList list = this.listsById.get(id);
		if (list == null) {
			throw notFound("No such task list: " + id);
		}
		return list;
	}

	/** The list whose file is at {@code path} (compared ignoring case), or null. */
	@Nullable TaskList listAt(String path) {
		for (TaskList list : this.lists) {
			if (PathNames.lower(list.path()).equals(PathNames.lower(path))) {
				return list;
			}
		}
		return null;
	}

	/** Every usable task, in list files and archives. */
	List<Located> tasks() {
		return List.copyOf(this.tasks.values());
	}

	@Nullable Located task(String id) {
		return this.tasks.get(id);
	}

	Located requireTask(String id) {
		Located located = this.tasks.get(id);
		if (located == null) {
			throw notFound("No such task: " + id);
		}
		return located;
	}

	/** The usable tasks of one list file. */
	List<Task> tasksIn(String path) {
		List<Task> found = new ArrayList<>();
		for (Located located : this.tasks.values()) {
			if (located.path().equals(path)) {
				found.add(located.task());
			}
		}
		return found;
	}

	/** Every archive file of the list {@code listId}, by path. */
	List<TaskSnapshot> archivesOf(String listId) {
		List<TaskSnapshot> archives = new ArrayList<>();
		for (TaskSnapshot snapshot : this.files.values()) {
			if (snapshot.archive() && listId.equals(snapshot.listId())) {
				archives.add(snapshot);
			}
		}
		archives.sort(Comparator.comparing(TaskSnapshot::path));
		return archives;
	}

	@Nullable TaskSnapshot file(String path) {
		return this.files.get(path);
	}

	/** Why the task API may not write {@code path}, or null. */
	@Nullable String blocked(String path) {
		return this.blocked.get(path);
	}

	List<TaskFileProblem> problems() {
		return this.problems;
	}

	static NotesException notFound(String detail) {
		return new NotesException(ErrorCode.NOT_FOUND, detail);
	}

}
