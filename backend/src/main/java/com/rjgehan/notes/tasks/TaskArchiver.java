package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.ListChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The archive rollover (ROADMAP item 4): every night, tasks closed more than {@code notes.tasks.archive-after} (90
 * days) ago move from their list into {@code Tasks/Archive/<List> <YYYY>.tasks}, by the year they were completed, so
 * active lists stay small. A closed task moves only together with its whole subtree, and only when its parent moves
 * too, so no subtask is ever separated from an open parent. The archive file is written before the list file, so an
 * interruption leaves a duplicate (reported), never a lost task.
 */
@Component
public class TaskArchiver {

	private static final Logger logger = LoggerFactory.getLogger(TaskArchiver.class);

	static final String FOLDER = "Tasks/Archive";

	private final TaskStore store;

	private final TaskWrites writes;

	private final NameRules nameRules;

	private final Duration archiveAfter;

	private final Author author;

	public TaskArchiver(TaskStore store, TaskWrites writes, NameRules nameRules, NotesProperties properties) {
		this.store = store;
		this.writes = writes;
		this.nameRules = nameRules;
		this.archiveAfter = properties.tasks().archiveAfter();
		this.author = new Author(properties.git().committerName(), properties.git().committerEmail());
	}

	@Scheduled(cron = "${notes.tasks.archive-cron:0 20 3 * * *}")
	public void nightly() {
		try {
			int moved = rollOver();
			if (moved > 0) {
				logger.info("Archived {} completed tasks", moved);
			}
		}
		catch (IOException | RuntimeException ex) {
			logger.warn("The task archive rollover failed: {}", ex.toString());
		}
	}

	/** Rolls every list over now; returns the number of tasks moved into archive files. */
	public int rollOver() throws IOException {
		Instant cutoff = this.writes.now().minus(this.archiveAfter);
		TaskCatalog catalog = this.store.catalog();
		int moved = 0;
		for (TaskList list : catalog.lists()) {
			boolean due = catalog.tasksIn(list.path()).stream().anyMatch((task) -> isOld(task, cutoff));
			if (!list.writable() || !due) {
				continue;
			}
			try {
				moved += rollOver(catalog, list, cutoff);
			}
			catch (NotesException | IOException ex) {
				logger.warn("Could not archive the completed tasks of {}: {}", list.path(), ex.getMessage());
			}
		}
		return moved;
	}

	private int rollOver(TaskCatalog catalog, TaskList list, Instant cutoff) throws IOException {
		ApiPath listPath = this.writes.existing(list.path());
		Map<Integer, ApiPath> archives = new TreeMap<>();
		for (Task task : catalog.tasksIn(list.path())) {
			if (isOld(task, cutoff)) {
				int year = task.completedAt().atZone(ZoneOffset.UTC).getYear();
				if (!archives.containsKey(year)) {
					ApiPath archive = archivePath(catalog, list, year);
					if (archive != null) {
						archives.put(year, archive);
					}
				}
			}
		}
		List<ApiPath> paths = new ArrayList<>();
		paths.add(listPath);
		paths.addAll(archives.values());
		try (TaskWrites.Session session = this.writes.open(paths, this.author, null)) {
			TaskFile file = session.require(listPath);
			if (file.isArchive() || !file.listId().equals(list.id())) {
				return 0;
			}
			TaskTree tree = new TaskTree(file);
			Set<String> movable = archivable(file, tree, cutoff);
			Map<Integer, List<String>> byYear = new TreeMap<>();
			for (String id : movable) {
				// A subtree stays together, in the archive of the year its top task was completed.
				ObjectNode top = tree.node(id);
				Set<String> seen = new HashSet<>();
				while (top != null && seen.add(TaskTree.id(top)) && tree.parentOf(top) != null
						&& movable.contains(tree.parentOf(top))) {
					top = tree.node(tree.parentOf(top));
				}
				Instant completed = (top != null) ? completedAt(top) : null;
				if (completed != null) {
					byYear.computeIfAbsent(completed.atZone(ZoneOffset.UTC).getYear(), (k) -> new ArrayList<>())
						.add(id);
				}
			}
			int moved = 0;
			for (Map.Entry<Integer, List<String>> entry : byYear.entrySet()) {
				ApiPath archivePath = archives.get(entry.getKey());
				if (archivePath == null) {
					continue;
				}
				TaskFile archive = session.read(archivePath);
				boolean create = archive == null;
				if (archive == null) {
					archive = TaskFile.newArchive(list.id(), file.listName());
				}
				else if (!archive.isArchive() || !archive.listId().equals(list.id())) {
					continue;
				}
				TaskTree archived = new TaskTree(archive);
				int here = 0;
				for (String id : entry.getValue()) {
					if (archived.node(id) != null) {
						// Already archived once (an interrupted rollover); keep the list's copy, which is reported.
						continue;
					}
					ObjectNode node = file.removeTask(id);
					if (node != null) {
						archive.addTask(node);
						here++;
					}
				}
				if (here > 0) {
					if (create) {
						session.create(archivePath, archive);
					}
					else {
						session.touch(archive);
					}
					moved += here;
				}
			}
			if (moved == 0) {
				return 0;
			}
			session.touchLosing(file);
			TaskList after = TaskCodec.readList(file.list(), listPath.nfc(), true, new ArrayList<>());
			session.publish(new ListChangedEvent(list.id(), after, null));
			session.commit();
			logger.info("ARCHIVE {} tasks from {}", moved, listPath.nfc());
			return moved;
		}
	}

	/**
	 * The archive file of {@code list} for {@code year}: {@code Tasks/Archive/<List> <YYYY>.tasks}, or with " 1",
	 * " 2", ... when that name is taken by something else. Null when no usable name is found.
	 */
	private @Nullable ApiPath archivePath(TaskCatalog catalog, TaskList list, int year) {
		String base = PathNames.basenameOf(PathNames.nameOf(list.path()));
		String name = this.nameRules.sanitizeAttachmentName(base + " " + year + ".tasks");
		for (int n = 0; n <= 99; n++) {
			String path = FOLDER + "/" + ((n == 0) ? name : NameRules.withSuffix(name, n));
			TaskSnapshot existing = catalog.file(path);
			if (existing != null) {
				if (existing.archive() && list.id().equals(existing.listId()) && existing.blocked() == null) {
					return this.writes.existing(path);
				}
				continue;
			}
			ApiPath fresh = this.writes.fresh(path);
			if (!this.writes.isTaken(fresh)) {
				return fresh;
			}
		}
		logger.warn("No archive file name is free for {} {}", list.path(), year);
		return null;
	}

	/**
	 * The ids of the closed, old enough tasks that can move: a task moves only with its whole subtree and only when
	 * its parent moves too.
	 */
	static Set<String> archivable(TaskFile file, TaskTree tree, Instant cutoff) {
		Set<String> ids = new LinkedHashSet<>();
		for (ObjectNode node : file.tasks()) {
			String status = node.path("status").stringValue("open");
			Instant completed = completedAt(node);
			if (!status.equals("open") && completed != null && completed.isBefore(cutoff)) {
				ids.add(TaskTree.id(node));
			}
		}
		boolean changed = true;
		while (changed) {
			changed = false;
			for (String id : new HashSet<>(ids)) {
				ObjectNode node = tree.node(id);
				String parent = (node != null) ? tree.parentOf(node) : null;
				boolean parentStays = parent != null && !ids.contains(parent);
				boolean childStays = tree.descendants(id).stream().anyMatch((child) -> !ids.contains(child));
				if (node == null || parentStays || childStays) {
					ids.remove(id);
					changed = true;
				}
			}
		}
		return ids;
	}

	private static boolean isOld(Task task, Instant cutoff) {
		return task.status().isClosed() && task.completedAt() != null && task.completedAt().isBefore(cutoff);
	}

	private static @Nullable Instant completedAt(ObjectNode node) {
		String value = node.path("completedAt").stringValue(null);
		if (value == null) {
			return null;
		}
		try {
			return Instant.parse(value);
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

}
