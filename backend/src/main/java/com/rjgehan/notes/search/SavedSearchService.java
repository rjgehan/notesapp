package com.rjgehan.notes.search;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.SavedSearch;
import com.rjgehan.notes.api.dto.SavedSearchesResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.SavedSearchesChangedEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.SearchQueryParser;
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
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Saved searches (API.md §12.4) live in {@code .notesapp/searches.json}, so they sync to every device and are
 * committed with the vault's history. The list is replaced as a whole with the version protocol of API.md §4 (the
 * file's blob id): a client that saw an older list gets {@code 409 version-conflict} and re-applies its change.
 */
@Service
public class SavedSearchService {

	private static final Logger logger = LoggerFactory.getLogger(SavedSearchService.class);

	public static final String FILE = ".notesapp/searches.json";

	public static final int SCHEMA_VERSION = 1;

	public static final int MAX_SEARCHES = 100;

	public static final int MAX_NAME = 120;

	private static final ApiPath PATH = ApiPath.of(FILE);

	private static final Pattern ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

	private final VaultFs fs;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final JsonMapper mapper;

	private final ReentrantLock lock = new ReentrantLock();

	public SavedSearchService(VaultFs fs, CommitBatcher batcher, EventHub hub, JsonMapper mapper) {
		this.fs = fs;
		this.batcher = batcher;
		this.hub = hub;
		this.mapper = mapper;
	}

	/** {@code GET /api/searches}. A file that cannot be read as saved searches lists none (and is logged). */
	public SavedSearchesResponse get() throws IOException {
		byte[] bytes = readOrNull();
		if (bytes == null) {
			return new SavedSearchesResponse(List.of(), null);
		}
		return new SavedSearchesResponse(parseFile(bytes), Hashing.blobId(bytes));
	}

	/** {@code PUT /api/searches}: validates, then writes when {@code baseVersion} matches the file on disk. */
	public SavedSearchesResponse update(@Nullable JsonNode searches, @Nullable String baseVersion, Identity identity,
			@Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		List<SavedSearch> list = validate(searches, errors);
		if (!errors.isEmpty()) {
			throw new NotesException(ErrorCode.BAD_REQUEST,
					"Invalid saved searches: " + errors.get(0).field() + " " + errors.get(0).message(),
					Map.of("errors", errors));
		}
		byte[] bytes = serialize(list);
		String version = Hashing.blobId(bytes);
		try (CommitBatcher.Operation operation = this.batcher.beginOperation()) {
			lock();
			try {
				byte[] disk = readOrNull();
				String diskVersion = (disk != null) ? Hashing.blobId(disk) : null;
				if (version.equals(diskVersion)) {
					return new SavedSearchesResponse(list, version);
				}
				if (!Objects.equals(diskVersion, emptyToNull(baseVersion))) {
					BasicFileAttributes attributes = this.fs.attributes(FILE);
					throw new VersionConflictException(FILE, diskVersion,
							(disk != null) ? TextCodec.decode(disk).text() : null,
							(attributes != null) ? attributes.lastModifiedTime().toInstant() : null, null,
							"The saved searches changed on the server");
				}
				Author author = Author.of(identity);
				this.batcher.prepareWrite(author);
				Files.createDirectories(this.fs.resolve(FILE).getParent());
				this.fs.atomicWrite(FILE, bytes);
				this.batcher.markDirty(PATH, author);
				this.hub.publish(new SavedSearchesChangedEvent(version, origin));
				logger.info("SEARCHES saved ({} searches) client={} user={}", list.size(), origin, identity.login());
				return new SavedSearchesResponse(list, version);
			}
			finally {
				this.lock.unlock();
			}
		}
	}

	private List<SavedSearch> validate(@Nullable JsonNode searches, List<FieldError> errors) {
		List<SavedSearch> list = new ArrayList<>();
		if (searches == null || !searches.isArray()) {
			errors.add(new FieldError("searches", "must be an array"));
			return list;
		}
		if (searches.size() > MAX_SEARCHES) {
			errors.add(new FieldError("searches", "must not hold more than " + MAX_SEARCHES + " searches"));
			return list;
		}
		Set<String> ids = new HashSet<>();
		for (int i = 0; i < searches.size(); i++) {
			JsonNode item = searches.get(i);
			String prefix = "searches[" + i + "].";
			String id = text(item, "id");
			String name = text(item, "name");
			String query = text(item, "query");
			String sort = text(item, "sort");
			if (id == null || !ID.matcher(id).matches()) {
				errors.add(new FieldError(prefix + "id", "must be 1 to 64 letters, digits or dashes"));
			}
			else if (!ids.add(id)) {
				errors.add(new FieldError(prefix + "id", "is used twice"));
			}
			if (name == null || name.isBlank() || name.length() > MAX_NAME) {
				errors.add(new FieldError(prefix + "name", "must be 1 to " + MAX_NAME + " characters"));
			}
			if (query == null || query.isBlank() || query.length() > SearchQueryParser.MAX_LENGTH) {
				errors.add(new FieldError(prefix + "query",
						"must be 1 to " + SearchQueryParser.MAX_LENGTH + " characters"));
			}
			if (sort == null) {
				sort = "relevance";
			}
			else if (!sort.equals("relevance") && !sort.equals("mtime")) {
				errors.add(new FieldError(prefix + "sort", "must be relevance or mtime"));
			}
			if (id != null && name != null && query != null) {
				list.add(new SavedSearch(id, name.strip(), query, sort));
			}
		}
		return list;
	}

	private static @Nullable String text(@Nullable JsonNode item, String field) {
		JsonNode value = (item != null) ? item.get(field) : null;
		return (value != null && value.isString()) ? value.asString() : null;
	}

	private List<SavedSearch> parseFile(byte[] bytes) {
		JsonNode tree;
		try {
			tree = this.mapper.readTree(TextCodec.decode(bytes).text());
		}
		catch (JacksonException ex) {
			logger.warn("{} is not valid JSON; no saved searches are listed", FILE);
			return List.of();
		}
		JsonNode searches = (tree != null) ? tree.get("searches") : null;
		List<FieldError> errors = new ArrayList<>();
		List<SavedSearch> list = validate(searches, errors);
		if (!errors.isEmpty()) {
			logger.warn("{} has invalid entries ({} {}); they are skipped", FILE, errors.get(0).field(),
					errors.get(0).message());
		}
		return list;
	}

	private byte[] serialize(List<SavedSearch> list) {
		ObjectNode root = this.mapper.createObjectNode();
		root.put("schemaVersion", SCHEMA_VERSION);
		ArrayNode array = root.putArray("searches");
		for (SavedSearch search : list) {
			ObjectNode item = array.addObject();
			item.put("id", search.id());
			item.put("name", search.name());
			item.put("query", search.query());
			item.put("sort", search.sort());
		}
		return (this.mapper.writerWithDefaultPrettyPrinter().writeValueAsString(root) + "\n")
			.getBytes(StandardCharsets.UTF_8);
	}

	private byte @Nullable [] readOrNull() throws IOException {
		try {
			return this.fs.readBytes(FILE);
		}
		catch (NoSuchFileException ex) {
			return null;
		}
	}

	private static @Nullable String emptyToNull(@Nullable String value) {
		return (value == null || value.isBlank()) ? null : value;
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
