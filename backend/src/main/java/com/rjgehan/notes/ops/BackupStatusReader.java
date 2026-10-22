package com.rjgehan.notes.ops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;

import com.rjgehan.notes.api.dto.BackupState;
import com.rjgehan.notes.api.dto.BackupStatus;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.vaults.ServerWide;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.core.json.JsonReadFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * The last backup run as the status page shows it (ROADMAP items 1 and 38). The backup scheduler writes
 * {@code status.json} after every run (DESIGN §7.10): {@code lastRun}, {@code result}, {@code snapshot},
 * {@code offsite}, {@code lastSuccess} and {@code failures}. Compose mounts its directory read-only into the app at
 * {@code /backup-state}; the file is only ever read here, and anything unexpected in it reads as unknown, never as an
 * error of the app.
 */
@Component
@ServerWide
public class BackupStatusReader {

	private static final int MAX_SIZE = 64 * 1024;

	private static final int MAX_TEXT = 2000;

	private final Path file;

	private final Duration staleAfter;

	private final Clock clock;

	private final JsonMapper mapper;

	public BackupStatusReader(NotesProperties properties, Clock clock, JsonMapper mapper) {
		this.file = properties.backup().statusFile();
		this.staleAfter = properties.backup().staleAfter();
		this.clock = clock;
		this.mapper = mapper;
	}

	public BackupStatus read() {
		byte[] bytes;
		try {
			BasicFileAttributes attributes = Files.readAttributes(this.file, BasicFileAttributes.class);
			if (!attributes.isRegularFile() || attributes.size() > MAX_SIZE) {
				return BackupStatus.unknown("The backup status file is not a small regular file");
			}
			bytes = Files.readAllBytes(this.file);
		}
		catch (NoSuchFileException ex) {
			return BackupStatus.unknown(
					"No backup has reported here yet: backups are not set up, have not run, or their state is not "
							+ "mounted into the app");
		}
		catch (IOException ex) {
			return BackupStatus.unknown("The backup status file cannot be read (" + ex.getClass().getSimpleName() + ")");
		}
		JsonNode root;
		try {
			// Leniently: restic's output, cut to length by a shell script, can end in half a UTF-8 character (decoded
			// as U+FFFD here) or carry a raw control character (blanked by text()). Neither may hide a failed run.
			root = this.mapper.reader()
				.with(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS)
				.readTree(new String(bytes, StandardCharsets.UTF_8));
		}
		catch (JacksonException ex) {
			return BackupStatus.unknown("The backup status file is not valid JSON");
		}
		if (root == null || !root.isObject()) {
			return BackupStatus.unknown("The backup status file is not a JSON object");
		}
		Instant lastRun = instant(root, "lastRun");
		Instant lastSuccess = instant(root, "lastSuccess");
		String result = text(root, "result");
		BackupState state;
		if ("failed".equals(result)) {
			state = BackupState.FAILED;
		}
		else if (lastSuccess == null || lastSuccess.isBefore(this.clock.instant().minus(this.staleAfter))) {
			state = BackupState.STALE;
		}
		else {
			state = BackupState.OK;
		}
		return new BackupStatus(state, null, lastRun, lastSuccess, text(root, "snapshot"), text(root, "offsite"),
				text(root, "failures"));
	}

	/** A string member without control characters (except line breaks), shortened; null when missing or empty. */
	private static @Nullable String text(JsonNode root, String name) {
		JsonNode value = root.get(name);
		if (value == null || !value.isString()) {
			return null;
		}
		String text = value.stringValue().replaceAll("[\\p{Cntrl}&&[^\\n]]", " ").strip();
		if (text.isEmpty()) {
			return null;
		}
		return (text.length() > MAX_TEXT) ? text.substring(0, MAX_TEXT) + "…" : text;
	}

	private static @Nullable Instant instant(JsonNode root, String name) {
		String value = text(root, name);
		if (value == null) {
			return null;
		}
		try {
			return Instant.parse(value);
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

}
