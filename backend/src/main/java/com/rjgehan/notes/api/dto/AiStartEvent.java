package com.rjgehan.notes.api.dto;

import java.util.List;

/**
 * {@code event: start} (API.md §20.5): the model asked and the notes sent with this turn. {@code omitted} counts
 * notes that matched but did not fit within the context limit; {@code excluded} counts notes left out because they are
 * in an excluded folder.
 */
public record AiStartEvent(String model, List<AiSource> sources, int omitted, int excluded) {
}
