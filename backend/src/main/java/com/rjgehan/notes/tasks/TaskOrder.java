package com.rjgehan.notes.tasks;

import java.util.Comparator;
import java.util.List;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskSection;
import org.jspecify.annotations.Nullable;

/**
 * Manual order: fractional-index keys compare as plain strings; equal keys (possible after hand edits) fall back to
 * the id, so the order is always total and the same on every device.
 */
final class TaskOrder {

	static final Comparator<TaskList> LISTS = Comparator.comparing(TaskList::order)
		.thenComparing(TaskList::name, String.CASE_INSENSITIVE_ORDER)
		.thenComparing(TaskList::path);

	static final Comparator<TaskSection> SECTIONS = Comparator.comparing(TaskSection::order)
		.thenComparing(TaskSection::id);

	static final Comparator<Task> TASKS = Comparator.comparing(Task::order).thenComparing(Task::id);

	private TaskOrder() {
	}

	/**
	 * {@code count} keys for items placed right after {@code previous} and before {@code next} (either may be null
	 * for "at the start" or "at the end"). Returns null when the neighbours' keys do not allow it (invalid or
	 * out-of-order keys from a hand edit); the caller then renumbers the whole sequence.
	 */
	static @Nullable List<String> keysBetween(@Nullable String previous, @Nullable String next, int count) {
		if ((previous != null && !FractionalIndex.isValid(previous))
				|| (next != null && !FractionalIndex.isValid(next))
				|| (previous != null && next != null && previous.compareTo(next) >= 0)) {
			return null;
		}
		try {
			return FractionalIndex.between(previous, next, count);
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}

	/** Fresh keys for a whole sequence. */
	static List<String> renumber(int count) {
		return FractionalIndex.between(null, null, count);
	}

	/** A key after every key in {@code existing} (the end of a sequence). */
	static String after(List<String> existing) {
		String last = null;
		for (String key : existing) {
			if (FractionalIndex.isValid(key) && (last == null || key.compareTo(last) > 0)) {
				last = key;
			}
		}
		return FractionalIndex.between(last, null);
	}

}
