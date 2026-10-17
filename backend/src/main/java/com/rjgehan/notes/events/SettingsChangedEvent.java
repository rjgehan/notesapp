package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

public record SettingsChangedEvent(String version, @Nullable String origin) implements VaultEvent {

	@Override
	public String eventName() {
		return "settings.changed";
	}

	@Override
	public @Nullable String echoOrigin() {
		return this.origin;
	}

}
