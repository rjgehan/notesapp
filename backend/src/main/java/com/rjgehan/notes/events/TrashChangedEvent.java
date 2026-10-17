package com.rjgehan.notes.events;

/** The trash list changed; serialized as {@code {}}. */
public record TrashChangedEvent() implements VaultEvent {

	@Override
	public String eventName() {
		return "trash.changed";
	}

}
