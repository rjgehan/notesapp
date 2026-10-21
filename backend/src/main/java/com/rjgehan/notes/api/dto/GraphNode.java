package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * One node of {@code GET /api/graph} (API.md §11.4). {@code path} is the file's path, or for an unresolved node the
 * link target as first written, without {@code .md}; {@code tags} are a note's tags in their display casing.
 */
public record GraphNode(String path, GraphNodeType type, List<String> tags) {

	public GraphNode {
		tags = List.copyOf(tags);
	}

}
