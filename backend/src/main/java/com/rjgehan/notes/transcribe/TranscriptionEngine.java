package com.rjgehan.notes.transcribe;

import java.io.IOException;
import java.nio.file.Path;

import org.jspecify.annotations.Nullable;

/**
 * A speech-to-text service. {@link HttpTranscriptionEngine} talks to the configured one; tests substitute their own.
 */
public interface TranscriptionEngine {

	/**
	 * Transcribes {@code audio}.
	 * @throws IOException when the service cannot be reached, times out or fails; the message names the problem
	 * (an HTTP status, the service's own short error), never a key
	 */
	Transcript transcribe(AudioFile audio) throws IOException, InterruptedException;

	/** A recording in the vault: its file name (as the service sees it), content type, size and location on disk. */
	record AudioFile(String name, String contentType, long size, Path file) {
	}

	/** The text, and the language when the service reports it. */
	record Transcript(String text, @Nullable String language) {
	}

}
