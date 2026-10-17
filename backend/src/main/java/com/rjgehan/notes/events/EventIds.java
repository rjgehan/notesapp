package com.rjgehan.notes.events;

import org.jspecify.annotations.Nullable;

/** Event ids are {@code "<bootId>.<seq>"}: a base-36 boot id and a sequence that increases strictly within a boot. */
public final class EventIds {

	private EventIds() {
	}

	public record EventId(String bootId, long seq) {
	}

	public static String format(String bootId, long seq) {
		return bootId + "." + seq;
	}

	/** The parsed id, or null when it is not of the form {@code bootId.seq}. */
	public static @Nullable EventId parse(@Nullable String id) {
		if (id == null) {
			return null;
		}
		int dot = id.lastIndexOf('.');
		if (dot <= 0 || dot == id.length() - 1) {
			return null;
		}
		try {
			long seq = Long.parseLong(id.substring(dot + 1));
			return (seq < 0) ? null : new EventId(id.substring(0, dot), seq);
		}
		catch (NumberFormatException ex) {
			return null;
		}
	}

}
