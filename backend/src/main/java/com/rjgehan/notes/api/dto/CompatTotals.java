package com.rjgehan.notes.api.dto;

/** The vault's size and the report's findings by severity (occurrence counts). */
public record CompatTotals(int notes, int files, int errors, int warnings, int infos) {
}
