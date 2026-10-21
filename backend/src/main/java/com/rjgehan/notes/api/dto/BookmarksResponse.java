package com.rjgehan.notes.api.dto;

import java.util.List;

import tools.jackson.databind.node.ObjectNode;

/**
 * {@code GET /api/bookmarks}. Items stay JSON objects in Obsidian's {@code bookmarks.json} format, so fields this build
 * does not know (from Obsidian or a newer build) survive a round trip; the server validates the fields it knows.
 */
public record BookmarksResponse(String version, List<ObjectNode> items) {
}
