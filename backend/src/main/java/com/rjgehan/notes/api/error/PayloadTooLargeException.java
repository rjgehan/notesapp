package com.rjgehan.notes.api.error;

import java.io.IOException;

import org.jspecify.annotations.Nullable;

/**
 * Thrown while reading a chunked request body that passes the JSON body limit. It travels inside the framework's
 * read exception and is mapped back to {@code 413 too-large}.
 */
public class PayloadTooLargeException extends IOException {

	private final long limit;

	public PayloadTooLargeException(long limit) {
		super("The request body is larger than " + limit + " bytes");
		this.limit = limit;
	}

	public long limit() {
		return this.limit;
	}

	/** The limit carried by a {@link PayloadTooLargeException} in the cause chain, or null. */
	public static @Nullable Long limitOf(@Nullable Throwable ex) {
		Throwable current = ex;
		for (int depth = 0; current != null && depth < 16; depth++) {
			if (current instanceof PayloadTooLargeException tooLarge) {
				return tooLarge.limit;
			}
			current = current.getCause();
		}
		return null;
	}

}
