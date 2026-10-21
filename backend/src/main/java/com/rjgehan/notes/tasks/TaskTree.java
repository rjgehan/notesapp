package com.rjgehan.notes.tasks;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ObjectNode;

/**
 * The subtask structure of one file's tasks: parents, children, depth and siblings. A {@code parentId} that names no
 * task of the file (a hand edit) makes a task top-level here; cycles are cut where they are found.
 */
final class TaskTree {

	/** A subtask can be at most this deep: a task, its subtask and theirs. */
	static final int MAX_DEPTH = 3;

	static final Comparator<ObjectNode> ORDER = Comparator.comparing((ObjectNode node) -> order(node))
		.thenComparing(TaskTree::id);

	private final Map<String, ObjectNode> byId = new LinkedHashMap<>();

	private final Map<String, List<String>> children = new LinkedHashMap<>();

	TaskTree(TaskFile file) {
		for (ObjectNode node : file.tasks()) {
			String id = node.path("id").stringValue(null);
			if (id != null) {
				this.byId.putIfAbsent(id, node);
			}
		}
		for (ObjectNode node : this.byId.values()) {
			String parent = parentOf(node);
			if (parent != null) {
				this.children.computeIfAbsent(parent, (k) -> new ArrayList<>()).add(id(node));
			}
		}
	}

	static String id(ObjectNode node) {
		return node.path("id").stringValue("");
	}

	static String order(ObjectNode node) {
		return node.path("order").stringValue("");
	}

	static @Nullable String section(ObjectNode node) {
		return node.path("sectionId").stringValue(null);
	}

	@Nullable ObjectNode node(String id) {
		return this.byId.get(id);
	}

	/** The parent id, when it names another task of this file. */
	@Nullable String parentOf(ObjectNode node) {
		String parent = node.path("parentId").stringValue(null);
		return (parent != null && !parent.equals(id(node)) && this.byId.containsKey(parent)) ? parent : null;
	}

	/** 1 for a top-level task, 2 for its subtask, and so on. */
	int depth(String id) {
		int depth = 1;
		Set<String> seen = new HashSet<>();
		ObjectNode node = this.byId.get(id);
		while (node != null && seen.add(id(node))) {
			String parent = parentOf(node);
			if (parent == null) {
				break;
			}
			depth++;
			node = this.byId.get(parent);
		}
		return depth;
	}

	/** 1 for a task without subtasks, 2 when it has subtasks without their own, and so on. */
	int height(String id) {
		return height(id, new HashSet<>());
	}

	private int height(String id, Set<String> seen) {
		if (!seen.add(id)) {
			return 0;
		}
		int below = 0;
		for (String child : this.children.getOrDefault(id, List.of())) {
			below = Math.max(below, height(child, seen));
		}
		return below + 1;
	}

	/** The subtasks of {@code id} at any depth, parents before their children. */
	List<String> descendants(String id) {
		List<String> found = new ArrayList<>();
		Set<String> seen = new HashSet<>();
		seen.add(id);
		collect(id, found, seen);
		return found;
	}

	private void collect(String id, List<String> found, Set<String> seen) {
		for (String child : this.children.getOrDefault(id, List.of())) {
			if (seen.add(child)) {
				found.add(child);
				collect(child, found, seen);
			}
		}
	}

	/**
	 * The tasks that share a place in the manual order: the same parent and, for top-level tasks, the same section;
	 * sorted, without {@code excluded}.
	 */
	List<ObjectNode> siblings(@Nullable String parentId, @Nullable String sectionId, Set<String> excluded) {
		List<ObjectNode> siblings = new ArrayList<>();
		for (ObjectNode node : this.byId.values()) {
			if (excluded.contains(id(node)) || !Objects.equals(parentOf(node), parentId)) {
				continue;
			}
			if (parentId == null && !Objects.equals(section(node), sectionId)) {
				continue;
			}
			siblings.add(node);
		}
		siblings.sort(ORDER);
		return siblings;
	}

}
