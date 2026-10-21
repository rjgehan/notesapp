package com.rjgehan.notes.events;

import java.util.Map;

import com.rjgehan.notes.api.dto.FlashcardCard;
import com.rjgehan.notes.api.dto.FlashcardConfig;
import org.jspecify.annotations.Nullable;

/**
 * {@code flashcards.changed} (API.md §34.6): review records or the settings in {@code .notesapp/srs.json} changed.
 * {@code cards} holds the changed records ({@code null} for a removed one), or is {@code null} when too many changed
 * to list and clients refetch; {@code config} is set when the settings changed.
 */
public record FlashcardsChangedEvent(@Nullable Map<String, @Nullable FlashcardCard> cards,
		@Nullable FlashcardConfig config, String version, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "flashcards.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
