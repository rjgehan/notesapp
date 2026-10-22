package com.rjgehan.notes.properties;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import com.rjgehan.notes.api.dto.PropertyTypesResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.PropertyTypesChangedEvent;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Service;

/**
 * The vault's property types (ROADMAP item 13, API.md §38.2, DESIGN §5.38), in {@code .notesapp/types.json} in
 * Obsidian's own format ({@code {"types": {"due": "date"}}}), so the file can be copied to {@code .obsidian/} and
 * back. While it does not exist, an Obsidian vault's {@code .obsidian/types.json} is read instead; the first change
 * writes {@code .notesapp/types.json} with those types and the change. Changes are made one property at a time on
 * the server, under a lock, so two devices changing different properties never conflict.
 */
@Service
public class PropertyTypeService {

	private static final Logger logger = LoggerFactory.getLogger(PropertyTypeService.class);

	public static final String FILE = ".notesapp/types.json";

	public static final String OBSIDIAN_FILE = ".obsidian/types.json";

	/** Obsidian's property types. */
	public static final Set<String> TYPES = Set.of("text", "multitext", "number", "checkbox", "date", "datetime",
			"aliases", "tags");

	public static final int MAX_NAME = 256;

	public static final int MAX_TYPES = 2000;

	private static final ApiPath PATH = ApiPath.of(FILE);

	private final VaultFs fs;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final JsonMapper mapper;

	private final ReentrantLock lock = new ReentrantLock();

	public PropertyTypeService(VaultFs fs, CommitBatcher batcher, EventHub hub, JsonMapper mapper) {
		this.fs = fs;
		this.batcher = batcher;
		this.hub = hub;
		this.mapper = mapper;
	}

	/** {@code GET /api/properties/types}. */
	public PropertyTypesResponse get() throws IOException {
		byte[] own = readOrNull(FILE);
		if (own != null) {
			return new PropertyTypesResponse(parse(own, FILE), Hashing.blobId(own), "notesapp");
		}
		byte[] obsidian = readOrNull(OBSIDIAN_FILE);
		if (obsidian != null) {
			return new PropertyTypesResponse(parse(obsidian, OBSIDIAN_FILE), null, "obsidian");
		}
		return new PropertyTypesResponse(Map.of(), null, null);
	}

	/** The type of {@code name} (any case) in {@code types}, or null. */
	public static @Nullable String typeOf(Map<String, String> types, String name) {
		String key = keyOf(types, name);
		return (key != null) ? types.get(key) : null;
	}

	/** {@code PUT /api/properties/types}: sets one property's type, or removes it with a null type. */
	public PropertyTypesResponse set(@Nullable String name, @Nullable String type, Identity identity,
			@Nullable String origin) throws IOException {
		String checked = checkName(name, "name");
		if (type != null && !TYPES.contains(type)) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "Unknown property type: " + type,
					Map.of("errors", List.of(new FieldError("type", "must be one of "
							+ String.join(", ", TYPES.stream().sorted().toList()) + ", or null"))));
		}
		return change(identity, origin, (types) -> {
			String key = keyOf(types, checked);
			if (type == null) {
				return key != null && types.remove(key) != null;
			}
			if (key != null && key.equals(checked) && type.equals(types.get(key))) {
				return false;
			}
			if (key == null && types.size() >= MAX_TYPES) {
				throw new NotesException(ErrorCode.BAD_REQUEST, "Too many property types",
						Map.of("errors", List.of(new FieldError("name", "at most " + MAX_TYPES + " types"))));
			}
			if (key != null && !key.equals(checked)) {
				replaceKey(types, key, checked);
			}
			types.put(checked, type);
			return true;
		});
	}

	/**
	 * A property was renamed (API.md §38.4): its type moves to the new name unless that has one of its own. Returns
	 * whether the types changed (or, with {@code dryRun}, would change).
	 */
	boolean renamed(String from, String to, boolean dryRun, Identity identity, @Nullable String origin)
			throws IOException {
		if (dryRun) {
			return movable(get().types(), from, to) != null;
		}
		boolean[] changed = { false };
		change(identity, origin, (types) -> {
			String key = movable(types, from, to);
			if (key == null) {
				return false;
			}
			replaceKey(types, key, to);
			changed[0] = true;
			return true;
		});
		return changed[0];
	}

	/** The entry of {@code from} when it can move to {@code to}. */
	private static @Nullable String movable(Map<String, String> types, String from, String to) {
		String key = keyOf(types, from);
		String other = keyOf(types, to);
		if (key == null || key.equals(to) || (other != null && !other.equals(key))) {
			return null;
		}
		return key;
	}

	/** Renames an entry in place: it keeps its position. */
	private static void replaceKey(Map<String, String> types, String key, String to) {
		Map<String, String> copy = new LinkedHashMap<>(types);
		types.clear();
		copy.forEach((k, v) -> types.put(k.equals(key) ? to : k, v));
	}

	static String checkName(@Nullable String name, String field) {
		if (name == null || name.isBlank()) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "A property name is required",
					Map.of("errors", List.of(new FieldError(field, "is required"))));
		}
		String stripped = name.strip();
		if (stripped.length() > MAX_NAME || stripped.chars().anyMatch((c) -> c < 0x20 || c == 0x7f)) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "Invalid property name", Map.of("errors",
					List.of(new FieldError(field, "must be one line of at most " + MAX_NAME + " characters"))));
		}
		return stripped;
	}

	private interface Change {

		/** Changes the types in place; false when nothing changed. */
		boolean apply(Map<String, String> types);

	}

	private PropertyTypesResponse change(Identity identity, @Nullable String origin, Change change)
			throws IOException {
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				PropertyTypesResponse current = get();
				Map<String, String> types = new LinkedHashMap<>(current.types());
				if (!change.apply(types)) {
					return current;
				}
				byte[] bytes = serialize(types);
				String version = Hashing.blobId(bytes);
				Author author = Author.of(identity);
				this.batcher.prepareWrite(author);
				Files.createDirectories(this.fs.resolve(FILE).getParent());
				this.fs.atomicWrite(FILE, bytes);
				this.batcher.markDirty(PATH, author);
				this.hub.publish(new PropertyTypesChangedEvent(version, origin));
				logger.info("PROPERTY TYPES saved ({} types) client={} user={}", types.size(), origin,
						identity.login());
				return new PropertyTypesResponse(types, version, "notesapp");
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	private static @Nullable String keyOf(Map<String, String> types, String name) {
		if (types.containsKey(name)) {
			return name;
		}
		for (String key : types.keySet()) {
			if (FrontmatterKeys.sameName(key, name)) {
				return key;
			}
		}
		return null;
	}

	/** The {@code types} object of a types file; entries that are not strings are skipped. */
	private Map<String, String> parse(byte[] bytes, String file) {
		JsonNode tree;
		try {
			tree = this.mapper.readTree(TextCodec.decode(bytes).text());
		}
		catch (JacksonException ex) {
			logger.warn("{} is not valid JSON; no property types are read from it", file);
			return new LinkedHashMap<>();
		}
		JsonNode types = (tree != null) ? tree.get("types") : null;
		Map<String, String> out = new LinkedHashMap<>();
		if (types == null || !types.isObject()) {
			return out;
		}
		for (Map.Entry<String, JsonNode> entry : types.properties()) {
			if (entry.getValue().isString()) {
				out.put(entry.getKey(), entry.getValue().asString());
			}
		}
		return out;
	}

	/** Obsidian's layout ({@code JSON.stringify(value, null, 2)}), with a final line break. */
	private byte[] serialize(Map<String, String> types) {
		StringBuilder out = new StringBuilder("{\n  \"types\": {");
		String separator = "\n";
		for (Map.Entry<String, String> entry : types.entrySet()) {
			out.append(separator)
				.append("    ")
				.append(this.mapper.writeValueAsString(entry.getKey()))
				.append(": ")
				.append(this.mapper.writeValueAsString(entry.getValue()));
			separator = ",\n";
		}
		out.append(types.isEmpty() ? "}\n}\n" : "\n  }\n}\n");
		return out.toString().getBytes(StandardCharsets.UTF_8);
	}

	private byte @Nullable [] readOrNull(String path) throws IOException {
		try {
			return this.fs.readBytes(path);
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

}
