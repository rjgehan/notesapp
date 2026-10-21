package com.rjgehan.notes.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code MirrorStatus.state} (API.md §6.2). */
public enum MirrorState {

	/** Not configured, misconfigured, or history is off; {@code reason} says which. */
	@JsonProperty("disabled") DISABLED,

	/** Configured; the last push (if any) worked, and new commits are pushed after the delay. */
	@JsonProperty("ready") READY,

	/** Pushes fail and are being retried with backoff; {@code lastError} and {@code failingSince} are set. */
	@JsonProperty("failing") FAILING,

	/** The mirror has commits the vault's history lacks. Pushing stops until a push is requested again. */
	@JsonProperty("diverged") DIVERGED

}
