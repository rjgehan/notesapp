package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * An earlier turn of a conversation, as the device kept it (API.md §24.1): what was asked, the answer, and the notes
 * the server sent with it ({@code AiStartEvent.sources}). The server sends those notes again, as they are now.
 */
public record AiTurn(@Nullable AiPrompt prompt, @Nullable String answer, @Nullable List<String> sources) {
}
