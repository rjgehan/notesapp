package com.rjgehan.notes.index;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.GraphNode;
import com.rjgehan.notes.api.dto.GraphNodeType;
import com.rjgehan.notes.api.dto.GraphResponse;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * Builds the compact link graph of {@code GET /api/graph} (API.md §11.4, DESIGN §5.5.12) from the index. Called by
 * {@link VaultIndex} under its read lock.
 *
 * <ul>
 * <li>Nodes: every visible file in path order (notes, then every other kind as an attachment), then one node per
 * unresolved link target, in order of first appearance. Unresolved targets are grouped case-insensitively, without
 * {@code .md}, and keep the casing first seen.</li>
 * <li>Edges: one per (source, target) pair, with the number of links and embeds between them. Same-note links are
 * left out.</li>
 * <li>Files for which {@code excluded} holds ({@code settings.files.excludedPaths}) are left out, with their
 * edges.</li>
 * </ul>
 */
final class GraphBuilder {

	private GraphBuilder() {
	}

	static GraphResponse build(String version, Collection<FileRecord> files, LinkGraph links, TagIndex tags,
			Predicate<String> excluded) {
		Map<String, Integer> ids = new HashMap<>(files.size() * 2);
		List<GraphNode> nodes = new ArrayList<>(files.size());
		for (FileRecord record : files) {
			if (excluded.test(record.path())) {
				continue;
			}
			ids.put(record.path(), nodes.size());
			boolean note = record.kind() == FileKind.NOTE;
			nodes.add(new GraphNode(record.path(), note ? GraphNodeType.NOTE : GraphNodeType.ATTACHMENT,
					note ? tags.tagsOf(record.path()) : List.of()));
		}
		Map<String, Integer> unresolved = new HashMap<>();
		Map<Long, int[]> counts = new LinkedHashMap<>();
		for (FileRecord record : files) {
			Integer source = ids.get(record.path());
			if (source == null) {
				continue;
			}
			for (LinkGraph.Resolved link : links.outgoing(record.path())) {
				Integer target;
				if (link.target() != null) {
					if (link.target().equals(record.path())) {
						continue;
					}
					target = ids.get(link.target());
				}
				else {
					String name = unresolvedName(link.occ().target());
					if (name == null) {
						continue;
					}
					target = unresolved.computeIfAbsent(PathNames.lower(name), (key) -> {
						nodes.add(new GraphNode(name, GraphNodeType.UNRESOLVED, List.of()));
						return nodes.size() - 1;
					});
				}
				if (target == null) {
					continue;
				}
				counts.computeIfAbsent(((long) source << 32) | target, (key) -> new int[1])[0]++;
			}
		}
		List<Long> keys = new ArrayList<>(counts.keySet());
		keys.sort(null);
		int[] edges = new int[keys.size() * 3];
		int i = 0;
		for (long key : keys) {
			edges[i++] = (int) (key >>> 32);
			edges[i++] = (int) key;
			edges[i++] = counts.get(key)[0];
		}
		return new GraphResponse(version, false, nodes, edges);
	}

	/** The name of an unresolved target: trimmed, NFC, without a final {@code .md}; null when nothing is left. */
	static @Nullable String unresolvedName(String rawTarget) {
		String name = Syntax.trim(Normalizer.normalize(rawTarget, Normalizer.Form.NFC));
		if (name.length() >= 3 && name.regionMatches(true, name.length() - 3, ".md", 0, 3)) {
			name = Syntax.trim(name.substring(0, name.length() - 3));
		}
		return name.isEmpty() ? null : name;
	}

}
