package com.rjgehan.notes.vault;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The per-boot record of moves made through the app, {@code lower(oldPath) → newPath} (DESIGN §5.6). A save to a
 * path that no longer exists gets {@code movedTo} from it, so a device that missed the rename can follow the note.
 * Chains are followed at lookup time; the oldest entries are evicted beyond 10,000.
 */
@Component
public class MoveLog {

	static final int CAPACITY = 10_000;

	private static final int MAX_HOPS = 64;

	private final Map<String, String> moves = new LinkedHashMap<>(256, 0.75f, false) {

		@Override
		protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
			return size() > CAPACITY;
		}

	};

	public synchronized void record(String from, String to) {
		String key = PathNames.lower(from);
		// Re-inserting moves the entry to the youngest position.
		this.moves.remove(key);
		this.moves.put(key, to);
	}

	/** Where {@code path} ended up after one or more moves in this boot, or null when it was not moved. */
	public synchronized @Nullable String movedTo(String path) {
		String current = this.moves.get(PathNames.lower(path));
		if (current == null) {
			return null;
		}
		Set<String> seen = new HashSet<>();
		seen.add(PathNames.lower(path));
		for (int hops = 0; hops < MAX_HOPS; hops++) {
			String next = this.moves.get(PathNames.lower(current));
			if (next == null || !seen.add(PathNames.lower(current))) {
				break;
			}
			current = next;
		}
		return PathNames.lower(current).equals(PathNames.lower(path)) ? null : current;
	}

}
