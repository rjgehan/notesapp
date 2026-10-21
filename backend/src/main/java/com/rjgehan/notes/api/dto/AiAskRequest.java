package com.rjgehan.notes.api.dto;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * {@code POST /api/ai/ask} (API.md §20.2): a question about the vault. {@code activePath} is the open note, sent along
 * as the first source; {@code history} holds the earlier turns of this conversation, oldest first, kept on the device.
 */
public record AiAskRequest(@Nullable String question, @Nullable String activePath, @Nullable List<AiTurn> history) {
}
