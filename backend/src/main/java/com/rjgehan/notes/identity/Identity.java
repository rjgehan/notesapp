package com.rjgehan.notes.identity;

import com.fasterxml.jackson.annotation.JsonProperty;
import org.jspecify.annotations.Nullable;

/**
 * Who made a request: the Tailscale identity, or the configured default identity in the dev profile (DESIGN §5.13).
 * The login doubles as the git author email.
 */
public record Identity(String login, String name, @Nullable String profilePicUrl, Source source) {

	public enum Source {

		@JsonProperty("tailscale") TAILSCALE,
		@JsonProperty("default") DEFAULT

	}

	/** The request attribute under which the admitted identity is stored. */
	public static final String ATTRIBUTE = Identity.class.getName();

}
