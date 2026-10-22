package com.rjgehan.notes.api.dto;

/**
 * A Markdown checkbox task of a note ({@code - [ ] text}, API.md §40.1): its 0-based line, the character between
 * its brackets ({@code " "}, {@code "x"}, {@code "/"} …), whether that counts as done ({@code x} or {@code X}),
 * and its text.
 */
public record NoteTask(int line, String status, boolean done, String text) {
}
