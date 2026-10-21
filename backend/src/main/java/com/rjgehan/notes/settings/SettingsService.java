package com.rjgehan.notes.settings;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.SettingsResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.SettingsChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.core.util.DefaultIndenter;
import tools.jackson.core.util.DefaultPrettyPrinter;
import tools.jackson.core.util.Separators;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Loads, validates and saves {@code .notesapp/settings.json} (DESIGN §5.12) with a version token, like a text file.
 * The file's raw JSON tree is kept and known fields are merged into it on write, so fields added by a newer build
 * survive. A file written by a newer schema version, or one that fails validation, makes the settings read-only: what
 * could be read is served with defaults for the rest, writes are refused, and the file is never rewritten, so rolling
 * back a release never destroys settings.
 */
@Service
public class SettingsService {

	private static final Logger logger = LoggerFactory.getLogger(SettingsService.class);

	public static final String FILE = ".notesapp/settings.json";

	private static final ApiPath PATH = ApiPath.of(FILE);

	private static final DateTimeFormatter BACKUP_STAMP = DateTimeFormatter.ofPattern("uuuuMMdd'T'HHmmss'Z'")
		.withZone(ZoneOffset.UTC);

	private static final int MAX_REASON_ERRORS = 3;

	private record State(Settings settings, ObjectNode raw, String version, boolean readOnly,
			@Nullable String reason) {
	}

	private final VaultFs fs;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final Clock clock;

	private final JsonMapper mapper;

	private final ObjectWriter writer;

	private final ReentrantLock lock = new ReentrantLock();

	private volatile State state;

	public SettingsService(VaultFs fs, CommitBatcher batcher, EventHub hub, Clock clock, JsonMapper mapper) {
		this.fs = fs;
		this.batcher = batcher;
		this.hub = hub;
		this.clock = clock;
		this.mapper = mapper;
		DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
		DefaultPrettyPrinter printer = new DefaultPrettyPrinter(Separators.createDefaultInstance()
			.withObjectNameValueSpacing(Separators.Spacing.AFTER)
			.withObjectEmptySeparator("")
			.withArrayEmptySeparator("")).withObjectIndenter(indenter).withArrayIndenter(indenter);
		this.writer = mapper.writer().with(printer);
		ObjectNode raw = SettingsCodec.merge(JsonNodeFactory.instance.objectNode(), Settings.defaults());
		this.state = new State(Settings.defaults(), raw, Hashing.blobId(serialize(raw)), false, null);
	}

	/**
	 * Startup step 3: reads the file, creating it with defaults when it is missing, and replacing it (after a backup)
	 * when it is not JSON at all.
	 */
	public void load() throws IOException {
		byte[] bytes = readOrNull();
		if (bytes == null) {
			writeDefaults();
			logger.info("Created {} with default settings", FILE);
			return;
		}
		JsonNode tree = parse(bytes);
		if (!(tree instanceof ObjectNode raw)) {
			String backup = FILE + ".bak-" + BACKUP_STAMP.format(this.clock.instant());
			Files.move(this.fs.resolve(FILE), this.fs.resolve(backup), StandardCopyOption.REPLACE_EXISTING);
			logger.warn("{} is not valid JSON; moved it to {} and wrote defaults", FILE, backup);
			writeDefaults();
			return;
		}
		SettingsCodec.Parsed parsed = SettingsCodec.read(raw);
		Integer schemaVersion = SettingsCodec.schemaVersion(raw);
		String reason = null;
		if (schemaVersion != null && schemaVersion > Settings.SCHEMA_VERSION) {
			reason = "The settings were written by a newer version of NotesApp (schemaVersion " + schemaVersion + ")";
		}
		else if (!parsed.errors().isEmpty()) {
			reason = "The settings file is invalid: " + describe(parsed.errors());
		}
		this.state = new State(parsed.settings(), raw, Hashing.blobId(bytes), reason != null, reason);
		if (reason != null) {
			logger.error("SETTINGS_READ_ONLY {}; the file is left untouched and settings cannot be changed", reason);
		}
	}

	/** The settings in effect. */
	public Settings current() {
		return this.state.settings();
	}

	public SettingsResponse get() {
		State current = this.state;
		return new SettingsResponse(current.settings(), current.version(), current.readOnly());
	}

	public boolean isReadOnly() {
		return this.state.readOnly();
	}

	public @Nullable String readOnlyReason() {
		return this.state.reason();
	}

	/**
	 * {@code PUT /api/settings}: validates, then applies the version protocol of API.md §4 against the file on disk.
	 * Equal content is never a conflict.
	 */
	public SettingsResponse update(@Nullable JsonNode settings, @Nullable String baseVersion, Identity identity,
			@Nullable String origin) throws IOException {
		State current = this.state;
		if (current.readOnly()) {
			throw new NotesException(ErrorCode.SETTINGS_READ_ONLY, "The settings are read-only",
					Map.of("reason", String.valueOf(current.reason())));
		}
		SettingsCodec.Parsed parsed = SettingsCodec.read(settings);
		if (settings != null && settings.isObject() && settings.get("ai") == null) {
			// A page from before settings.ai existed (it reloads once it notices the new build) keeps what is set.
			Settings s = parsed.settings();
			parsed = new SettingsCodec.Parsed(new Settings(s.schemaVersion(), s.files(), s.dailyNotes(), s.templates(),
					s.editor(), current.settings().ai()), parsed.errors());
		}
		List<FieldError> errors = new ArrayList<>(parsed.errors());
		if (baseVersion == null || baseVersion.isBlank()) {
			errors.add(new FieldError("baseVersion", "is required"));
		}
		if (!errors.isEmpty()) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "Invalid settings: " + describe(errors),
					Map.of("errors", errors));
		}
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			return write(parsed, baseVersion, identity, origin);
		}
	}

	private SettingsResponse write(SettingsCodec.Parsed parsed, String baseVersion, Identity identity,
			@Nullable String origin) throws IOException {
		lock();
		try {
			State current = this.state;
			byte[] disk = readOrNull();
			String diskVersion = (disk != null) ? Hashing.blobId(disk) : current.version();
			// Merge into the file as it is now: it may have been edited by hand since startup, and fields this build
			// does not know must survive the write.
			JsonNode onDisk = (disk != null) ? parse(disk) : null;
			ObjectNode base = (onDisk instanceof ObjectNode tree) ? tree : current.raw();
			ObjectNode merged = SettingsCodec.merge(base, parsed.settings());
			byte[] bytes = serialize(merged);
			String version = Hashing.blobId(bytes);
			if (version.equals(diskVersion)) {
				this.state = new State(parsed.settings(), merged, version, false, null);
				return get();
			}
			if (!diskVersion.equals(baseVersion)) {
				throw conflict(disk, diskVersion, current);
			}
			Author author = Author.of(identity);
			this.batcher.prepareWrite(author);
			this.fs.atomicWrite(FILE, bytes);
			this.state = new State(parsed.settings(), merged, version, false, null);
			this.batcher.markDirty(PATH, author);
			this.hub.publish(new SettingsChangedEvent(version, origin));
			logger.info("SETTINGS saved client={} user={}", origin, identity.login());
			return get();
		}
		finally {
			this.lock.unlock();
		}
	}

	private VersionConflictException conflict(byte @Nullable [] disk, String diskVersion, State current) {
		String content = (disk != null) ? TextCodec.decode(disk).text() : TextCodec.decode(serialize(current.raw()))
			.text();
		BasicFileAttributes attributes = this.fs.attributes(FILE);
		return new VersionConflictException(FILE, diskVersion, content,
				(attributes != null) ? attributes.lastModifiedTime().toInstant() : null, null,
				"The settings changed on the server");
	}

	private void writeDefaults() throws IOException {
		ObjectNode raw = SettingsCodec.merge(JsonNodeFactory.instance.objectNode(), Settings.defaults());
		byte[] bytes = serialize(raw);
		Files.createDirectories(this.fs.resolve(FILE).getParent());
		this.fs.atomicWrite(FILE, bytes);
		this.state = new State(Settings.defaults(), raw, Hashing.blobId(bytes), false, null);
	}

	private @Nullable JsonNode parse(byte[] bytes) {
		try {
			return this.mapper.readTree(TextCodec.decode(bytes).text());
		}
		catch (JacksonException ex) {
			return null;
		}
	}

	private byte[] serialize(JsonNode tree) {
		return (this.writer.writeValueAsString(tree) + "\n").getBytes(StandardCharsets.UTF_8);
	}

	private byte @Nullable [] readOrNull() throws IOException {
		try {
			return this.fs.readBytes(FILE);
		}
		catch (NoSuchFileException ex) {
			return null;
		}
	}

	private void lock() {
		try {
			if (!this.lock.tryLock(5, TimeUnit.SECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
	}

	private static String describe(List<FieldError> errors) {
		String shown = errors.stream()
			.limit(MAX_REASON_ERRORS)
			.map((e) -> e.field() + " " + e.message())
			.collect(Collectors.joining("; "));
		return (errors.size() > MAX_REASON_ERRORS) ? shown + " (+" + (errors.size() - MAX_REASON_ERRORS) + " more)"
				: shown;
	}

}
