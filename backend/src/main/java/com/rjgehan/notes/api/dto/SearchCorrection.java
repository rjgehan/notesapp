package com.rjgehan.notes.api.dto;

import java.util.List;

/** A query word (normalized) that is not in the index, and the indexed words that were searched instead. */
public record SearchCorrection(String term, List<String> replacements) {
}
