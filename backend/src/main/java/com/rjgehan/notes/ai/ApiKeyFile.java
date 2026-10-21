package com.rjgehan.notes.ai;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.regex.Pattern;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The Anthropic API key, read from a file outside the vault: {@code notes.ai.api-key-file}
 * ({@code NOTES_AI_API_KEY_FILE}), by default {@code <notes.secrets-dir>/anthropic-key} ({@code /data/secrets}, DESIGN
 * §4.1), or a compose secret. It is never configured directly and never written to the vault, the settings, a log line
 * or an error text. The file is read again whenever its size or modification time changes, so a new key needs no
 * restart.
 */
@Component
public class ApiKeyFile {

	public static final String DEFAULT_NAME = "anthropic-key";

	private static final int MAX_SIZE = 4096;

	/** Printable ASCII without spaces, so a key can never break out of its header. */
	private static final Pattern KEY = Pattern.compile("[\\x21-\\x7E]{8,1024}");

	/** What reading the file gave: the key, or none with the reason (which never quotes the file's content). */
	public record Loaded(@Nullable String key, @Nullable String problem) {

		public boolean present() {
			return this.key != null;
		}

		@Override
		public String toString() {
			return "ApiKeyFile.Loaded[present=" + present() + ", problem=" + this.problem + "]";
		}

	}

	private record Cached(long size, FileTime modified, Loaded loaded) {
	}

	private final Path file;

	private volatile @Nullable Cached cached;

	@Autowired
	public ApiKeyFile(AiProperties properties, NotesProperties notes) {
		this(properties.apiKeyFile().isBlank() ? notes.secretsDir().resolve(DEFAULT_NAME)
				: Path.of(properties.apiKeyFile().strip()));
	}

	ApiKeyFile(Path file) {
		this.file = file;
	}

	/** The file's name, for messages; the directory is the operator's business. */
	public String fileName() {
		Path name = this.file.getFileName();
		return (name != null) ? name.toString() : this.file.toString();
	}

	public Path path() {
		return this.file;
	}

	/** Reads the key, from the cache when the file has not changed. */
	public Loaded load() {
		BasicFileAttributes attributes;
		try {
			attributes = Files.readAttributes(this.file, BasicFileAttributes.class);
		}
		catch (NoSuchFileException ex) {
			this.cached = null;
			return new Loaded(null, "no API key: " + fileName() + " does not exist");
		}
		catch (IOException ex) {
			this.cached = null;
			return new Loaded(null, "the API key file cannot be read (" + ex.getClass().getSimpleName() + ")");
		}
		Cached current = this.cached;
		if (current != null && current.size() == attributes.size()
				&& current.modified().equals(attributes.lastModifiedTime())) {
			return current.loaded();
		}
		Loaded loaded = read(attributes);
		this.cached = new Cached(attributes.size(), attributes.lastModifiedTime(), loaded);
		return loaded;
	}

	private Loaded read(BasicFileAttributes attributes) {
		if (!attributes.isRegularFile()) {
			return new Loaded(null, fileName() + " is not a file");
		}
		if (attributes.size() > MAX_SIZE) {
			return new Loaded(null, fileName() + " is too large to be an API key");
		}
		String text;
		try {
			text = Files.readString(this.file, StandardCharsets.UTF_8).strip();
		}
		catch (AccessDeniedException ex) {
			return new Loaded(null, fileName() + " is not readable by the app's user (uid 1000)");
		}
		catch (IOException ex) {
			return new Loaded(null, "the API key file cannot be read (" + ex.getClass().getSimpleName() + ")");
		}
		if (text.isEmpty()) {
			return new Loaded(null, "no API key: " + fileName() + " is empty");
		}
		if (!KEY.matcher(text).matches()) {
			return new Loaded(null, fileName() + " must hold just the key, on one line");
		}
		return new Loaded(text, null);
	}

}
