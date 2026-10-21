package com.rjgehan.notes.events;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.jspecify.annotations.Nullable;

/**
 * One server-sent event (API.md §16.4). {@link #eventName()} is the SSE {@code event:} name. Content events carry the
 * {@code origin} client id and are not delivered back to that client ({@link #echoOrigin()}).
 */
public sealed interface VaultEvent permits HelloEvent, PingEvent, FileEvent, FileDeletedEvent, FolderEvent,
		FolderDeletedEvent, MovedEvent, TrashChangedEvent, HistoryCommittedEvent, SettingsChangedEvent,
		StatusChangedEvent, ResyncEvent, TaskEvent, TaskDeletedEvent, ListChangedEvent {

	@JsonIgnore
	String eventName();

	@JsonIgnore
	default @Nullable String echoOrigin() {
		return null;
	}

}
