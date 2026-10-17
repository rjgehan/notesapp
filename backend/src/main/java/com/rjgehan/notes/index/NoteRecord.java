package com.rjgehan.notes.index;

/** A note within its size limit: its text and parse, kept in memory for backlinks, mentions and search. */
public record NoteRecord(String path, String version, String text, NoteParse parse, int docId) {
}
