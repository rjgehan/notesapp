package com.rjgehan.notes.api.dto;

/** A section of a list (also a Kanban column); {@code order} is a fractional-index key. */
public record TaskSection(String id, String name, String order) {
}
