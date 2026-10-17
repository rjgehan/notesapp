package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * The index's lookup as it will be after a move: the moved files' old paths are gone and their new paths exist. Used
 * to plan link rewrites before anything is touched. Must be used under the index lock, like the lookup it wraps.
 */
final class MovedLookup implements LinkResolver.Lookup {

	private final LinkResolver.Lookup base;

	private final Map<String, String> moved;

	private final Map<String, List<String>> addedByLowerPath = new HashMap<>();

	private final Map<String, List<String>> addedByLowerName = new HashMap<>();

	MovedLookup(LinkResolver.Lookup base, Map<String, String> moved) {
		this.base = base;
		this.moved = moved;
		for (String to : moved.values()) {
			this.addedByLowerPath.computeIfAbsent(PathNames.lower(to), (k) -> new ArrayList<>(1)).add(to);
			this.addedByLowerName.computeIfAbsent(PathNames.lower(PathNames.nameOf(to)), (k) -> new ArrayList<>(1))
				.add(to);
		}
	}

	@Override
	public List<String> filesByLowerPath(String lowerPath) {
		return merge(this.base.filesByLowerPath(lowerPath), this.addedByLowerPath.get(lowerPath));
	}

	@Override
	public List<String> filesByLowerName(String lowerName) {
		return merge(this.base.filesByLowerName(lowerName), this.addedByLowerName.get(lowerName));
	}

	private List<String> merge(List<String> existing, @Nullable List<String> added) {
		List<String> out = new ArrayList<>(existing.size() + ((added != null) ? added.size() : 0));
		for (String path : existing) {
			if (!this.moved.containsKey(path)) {
				out.add(path);
			}
		}
		if (added != null) {
			out.addAll(added);
		}
		return out;
	}

}
