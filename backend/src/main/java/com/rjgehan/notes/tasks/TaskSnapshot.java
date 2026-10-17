package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskFileProblem;
import com.rjgehan.notes.api.dto.TaskList;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ObjectNode;

/**
 * One {@code .tasks} file as read at {@code version}: its list (for a list file), its usable tasks, what is wrong
 * with it, and whether the task API may write it. Immutable, so request threads share it through the
 * {@link TaskStore} cache.
 */
record TaskSnapshot(String path, String version, @Nullable String listId, @Nullable String listName, boolean archive,
		@Nullable TaskList list, List<Task> tasks, List<TaskFileProblem> problems, @Nullable String blocked) {

	/** A file the task API cannot use at all; {@code reason} says why. */
	static TaskSnapshot unusable(String path, String version, String reason) {
		return new TaskSnapshot(path, version, null, null, false, null, List.of(),
				List.of(new TaskFileProblem(path, null, reason)), reason);
	}

	/** Reads a parsed file. A file written by a newer format version is shown but blocked for writes. */
	static TaskSnapshot of(String path, String version, TaskFile file) {
		List<TaskFileProblem> problems = new ArrayList<>();
		String blocked = null;
		if (file.formatVersion() > TaskFile.FORMAT_VERSION) {
			blocked = "written by a newer version of NotesApp (format version " + file.formatVersion()
					+ "); this version only reads it";
			problems.add(new TaskFileProblem(path, null, blocked));
		}
		boolean archive = file.isArchive();
		String listId = file.listId();
		TaskList list = null;
		if (!archive) {
			List<String> listProblems = new ArrayList<>();
			list = TaskCodec.readList(file.list(), path, blocked == null, listProblems);
			listProblems.forEach((problem) -> problems.add(new TaskFileProblem(path, null, problem)));
		}
		List<Task> tasks = new ArrayList<>();
		int unnamed = 0;
		for (ObjectNode node : file.tasks()) {
			TaskCodec.ReadTask read = TaskCodec.readTask(node, listId, archive);
			String id = (read.task() != null) ? read.task().id() : node.path("id").stringValue(null);
			if (id == null) {
				unnamed++;
			}
			read.problems().forEach((problem) -> problems.add(new TaskFileProblem(path, id, problem)));
			if (read.task() != null) {
				tasks.add(read.task());
			}
		}
		if (unnamed > 0) {
			problems.removeIf((problem) -> problem.taskId() == null && problem.reason().startsWith("a task has no"));
			problems.add(new TaskFileProblem(path, null,
					unnamed + ((unnamed == 1) ? " task has" : " tasks have") + " no valid \"id\""));
		}
		int stray = file.root.path("tasks").size() - file.tasks().size();
		if (stray > 0) {
			problems.add(new TaskFileProblem(path, null, stray + " entries of \"tasks\" are not objects"));
		}
		return new TaskSnapshot(path, version, listId, file.listName(), archive, list, List.copyOf(tasks),
				List.copyOf(problems), blocked);
	}

}
