package com.rjgehan.notes.api.dto;

/**
 * The answer of {@code POST /api/notes/block-id} (API.md §37): the block's id, whether it was added now (false when
 * the block already had one), and the note after the call.
 */
public record BlockIdResult(String id, boolean created, int line, FileEntry file) {
}
