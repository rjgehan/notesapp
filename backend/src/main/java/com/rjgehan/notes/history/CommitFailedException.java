package com.rjgehan.notes.history;

/** A git commit failed; the paths it covered stay pending and the batcher keeps retrying. */
public class CommitFailedException extends RuntimeException {

	public CommitFailedException(Throwable cause) {
		super("Git commit failed: " + cause.getMessage(), cause);
	}

}
