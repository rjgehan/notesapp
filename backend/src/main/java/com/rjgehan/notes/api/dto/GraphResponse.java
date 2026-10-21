package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * {@code GET /api/graph} (API.md §11.4): every visible file and every unresolved link target as nodes, and the links
 * between them as flat {@code [source, target, count]} triples of node indexes. With {@code unchanged}, the graph is
 * still the one {@code version} names and {@code nodes} and {@code edges} are empty.
 */
public record GraphResponse(String version, boolean unchanged, List<GraphNode> nodes, int[] edges) {

	public GraphResponse {
		nodes = List.copyOf(nodes);
	}

}
