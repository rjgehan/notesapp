package com.rjgehan.notes.history;

import java.time.Instant;
import java.time.ZoneId;

import com.rjgehan.notes.identity.Identity;
import org.eclipse.jgit.lib.PersonIdent;

/**
 * A git author: the request's identity ({@code name}, with the login as email), or {@link #EXTERNAL} for changes made
 * outside the app (DESIGN §5.8).
 */
public record Author(String name, String email) {

	public static final Author EXTERNAL = new Author("External", "external@notes");

	public static Author of(Identity identity) {
		return new Author(identity.name(), identity.login());
	}

	PersonIdent ident(Instant when) {
		return new PersonIdent(this.name, this.email, when, ZoneId.systemDefault());
	}

}
