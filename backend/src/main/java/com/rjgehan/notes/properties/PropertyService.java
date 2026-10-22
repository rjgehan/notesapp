package com.rjgehan.notes.properties;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FailedUpdate;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.PropertiesResponse;
import com.rjgehan.notes.api.dto.PropertyInfo;
import com.rjgehan.notes.api.dto.PropertyRenameResult;
import com.rjgehan.notes.api.dto.PropertyUpdate;
import com.rjgehan.notes.api.dto.PropertyValue;
import com.rjgehan.notes.api.dto.PropertyValuesResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.history.CommitFailedException;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileIndexer;
import com.rjgehan.notes.index.Frontmatter;
import com.rjgehan.notes.index.NoteRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileService;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import com.rjgehan.notes.vault.VaultLocks;
import com.rjgehan.notes.watch.VaultReconciler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Frontmatter properties across the vault (ROADMAP item 13, API.md §38, DESIGN §5.38): the list of every property
 * with its note count and types, the values one property has, and renaming a property in every note.
 *
 * <p>
 * A rename runs like a heading rename (DESIGN §5.22): under the vault write lock, each note is read from disk (a note
 * the watcher has not caught up with is reconciled first, so an external edit is never reverted), only the key's own
 * characters are replaced ({@link FrontmatterKeys}), and the rewritten notes are committed together. Open editors get
 * the usual {@code file.changed} event and merge it like any other device's edit. The property's type follows it.
 */
@Service
public class PropertyService {

	private static final Logger logger = LoggerFactory.getLogger(PropertyService.class);

	/** The most values {@link #values} lists. */
	public static final int MAX_VALUES = 500;

	private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

	private static final Pattern DATETIME = Pattern.compile("\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?");

	private final VaultFs fs;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final FileIndexer indexer;

	private final VaultReconciler reconciler;

	private final CommitBatcher batcher;

	private final EventHub hub;

	private final PropertyTypeService types;

	public PropertyService(VaultFs fs, VaultLocks locks, VaultIndex index, FileService files, FileIndexer indexer,
			VaultReconciler reconciler, CommitBatcher batcher, EventHub hub, PropertyTypeService types) {
		this.fs = fs;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.indexer = indexer;
		this.reconciler = reconciler;
		this.batcher = batcher;
		this.hub = hub;
		this.types = types;
	}

	// ---------------------------------------------------------------- the list

	private static final class Tally {

		final Map<String, Integer> spellings = new LinkedHashMap<>();

		final Map<String, Integer> kinds = new HashMap<>();

		int count;

	}

	/** {@code GET /api/properties}: every property, by name (case-insensitively), sorted by name. */
	public PropertiesResponse list() throws IOException {
		Map<String, Tally> tallies = new HashMap<>();
		for (NoteRecord note : this.index.notes()) {
			Map<String, @Nullable Object> data = dataOf(note);
			if (data == null) {
				continue;
			}
			Set<String> seen = new HashSet<>();
			for (Map.Entry<String, @Nullable Object> entry : data.entrySet()) {
				String lower = entry.getKey().toLowerCase(Locale.ROOT);
				Tally tally = tallies.computeIfAbsent(lower, (k) -> new Tally());
				tally.spellings.merge(entry.getKey(), 1, Integer::sum);
				if (seen.add(lower)) {
					tally.count++;
				}
				String kind = inferType(entry.getValue());
				if (kind != null) {
					tally.kinds.merge(kind, 1, Integer::sum);
				}
			}
		}
		Map<String, String> registry = this.types.get().types();
		List<PropertyInfo> properties = new ArrayList<>();
		for (Tally tally : tallies.values()) {
			String name = mostUsed(tally.spellings, "");
			String inferred = mostUsed(tally.kinds, "text");
			properties.add(new PropertyInfo(name, tally.count, PropertyTypeService.typeOf(registry, name), inferred));
		}
		properties.sort(Comparator.comparing((PropertyInfo p) -> p.name().toLowerCase(Locale.ROOT))
			.thenComparing(PropertyInfo::name));
		return new PropertiesResponse(properties);
	}

	/** The type a value looks like (API.md §38.1), or null for an empty value, which says nothing. */
	static @Nullable String inferType(@Nullable Object value) {
		if (value == null) {
			return null;
		}
		if (value instanceof Boolean) {
			return "checkbox";
		}
		if (value instanceof Number) {
			return "number";
		}
		if (value instanceof Collection<?>) {
			return "multitext";
		}
		if (value instanceof String s) {
			if (s.isEmpty()) {
				return null;
			}
			if (DATE.matcher(s).matches()) {
				return "date";
			}
			if (DATETIME.matcher(s).matches()) {
				return "datetime";
			}
		}
		return "text";
	}

	/** The most used key; ties go to the first seen. */
	private static String mostUsed(Map<String, Integer> counts, String fallback) {
		String best = fallback;
		int most = 0;
		for (Map.Entry<String, Integer> entry : counts.entrySet()) {
			if (entry.getValue() > most) {
				best = entry.getKey();
				most = entry.getValue();
			}
		}
		return best;
	}

	/** {@code GET /api/properties/values?name=}: the property's values (list items one by one), most used first. */
	public PropertyValuesResponse values(@Nullable String name) {
		String wanted = PropertyTypeService.checkName(name, "name");
		Map<String, Integer> counts = new HashMap<>();
		for (NoteRecord note : this.index.notes()) {
			Map<String, @Nullable Object> data = dataOf(note);
			if (data == null) {
				continue;
			}
			Set<String> seen = new HashSet<>();
			for (Map.Entry<String, @Nullable Object> entry : data.entrySet()) {
				if (FrontmatterKeys.sameName(entry.getKey(), wanted)) {
					scalars(entry.getValue(), seen);
				}
			}
			seen.forEach((value) -> counts.merge(value, 1, Integer::sum));
		}
		List<PropertyValue> values = counts.entrySet()
			.stream()
			.map((e) -> new PropertyValue(e.getKey(), e.getValue()))
			.sorted(Comparator.comparingInt(PropertyValue::count)
				.reversed()
				.thenComparing((PropertyValue v) -> v.value().toLowerCase(Locale.ROOT))
				.thenComparing(PropertyValue::value))
			.limit(MAX_VALUES)
			.toList();
		return new PropertyValuesResponse(wanted, values);
	}

	/** The non-empty scalars of a value: the value itself, or the items of a list. */
	static void scalars(@Nullable Object value, Collection<String> out) {
		if (value instanceof Collection<?> items) {
			for (Object item : items) {
				if (item != null && !(item instanceof Map<?, ?>) && !(item instanceof Collection<?>)
						&& !String.valueOf(item).isEmpty()) {
					out.add(String.valueOf(item));
				}
			}
		}
		else if (value != null && !(value instanceof Map<?, ?>) && !String.valueOf(value).isEmpty()) {
			out.add(String.valueOf(value));
		}
	}

	private @Nullable Map<String, @Nullable Object> dataOf(NoteRecord note) {
		Frontmatter frontmatter = note.parse().frontmatter();
		return (frontmatter != null) ? frontmatter.data() : null;
	}

	// ---------------------------------------------------------------- rename

	/** {@code POST /api/properties/rename}. */
	public PropertyRenameResult rename(@Nullable String from, @Nullable String to, boolean dryRun, Identity identity,
			@Nullable String origin) throws IOException {
		String oldName = PropertyTypeService.checkName(from, "from");
		String newName = PropertyTypeService.checkName(to, "to");
		if (oldName.equals(newName)) {
			throw new NotesException(ErrorCode.BAD_REQUEST, "The new name is the old name",
					Map.of("errors", List.of(new FieldError("to", "must differ from the old name"))));
		}
		try (CommitBatcher.Operation operation = this.batcher.beginOperation();
				VaultLocks.Held held = this.locks.write()) {
			// Every note whose indexed frontmatter has the property; each is read again from disk below.
			Set<String> candidates = new TreeSet<>();
			for (NoteRecord note : this.index.notes()) {
				Map<String, @Nullable Object> data = dataOf(note);
				if (data != null && data.keySet().stream().anyMatch((k) -> FrontmatterKeys.sameName(k, oldName))
						&& this.indexer.kindOf(note.path()) == FileKind.NOTE) {
					candidates.add(note.path());
				}
			}
			if (!dryRun && !candidates.isEmpty()) {
				// Pending edits are committed first, so the rename's commit holds only the rename (as for a move).
				flushPending();
			}
			List<PropertyUpdate> updates = new ArrayList<>();
			List<FailedUpdate> failed = new ArrayList<>();
			List<FileEntry> entries = new ArrayList<>();
			List<ApiPath> written = new ArrayList<>();
			for (String path : candidates) {
				renameIn(path, oldName, newName, dryRun, updates, failed, entries, written);
			}
			boolean typeMoved = this.types.renamed(oldName, newName, dryRun, identity, origin);
			if (dryRun) {
				return new PropertyRenameResult(true, oldName, newName, updates, failed, typeMoved, null);
			}
			GitStore.Commit commit = null;
			if (!written.isEmpty()) {
				int count = written.size();
				String subject = "Rename property “" + oldName + "” → “" + newName + "” (" + count
						+ ((count == 1) ? " note)" : " notes)");
				String body = written.stream().map(ApiPath::nfc).collect(Collectors.joining("\n"));
				commit = this.batcher.commitNow(subject, body, Author.of(identity), written);
			}
			entries.forEach((entry) -> this.hub.publish(FileEvent.changed(entry, origin)));
			logger.info("PROPERTY RENAME \"{}\" -> \"{}\" notes={} failed={} client={} user={}", oldName, newName,
					updates.size(), failed.size(), origin, identity.login());
			return new PropertyRenameResult(false, oldName, newName, updates, failed, typeMoved,
					(commit != null) ? commit.id() : null);
		}
	}

	private void renameIn(String path, String oldName, String newName, boolean dryRun, List<PropertyUpdate> updates,
			List<FailedUpdate> failed, List<FileEntry> entries, List<ApiPath> written) throws IOException {
		NoteRecord record = this.index.note(path);
		if (record == null) {
			return;
		}
		ApiPath note = existing(path);
		byte[] bytes = this.fs.readBytes(note.disk());
		if (!dryRun && !Hashing.blobId(bytes).equals(record.version())) {
			// Changed on disk behind the watcher's back: indexed (and committed as External) first.
			this.reconciler.reconcileLocked(note);
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		if (decoded.lossy()) {
			failed.add(new FailedUpdate(path, FailedReason.NOT_UTF8));
			return;
		}
		FrontmatterKeys.Result result = FrontmatterKeys.rename(decoded.text(), oldName, newName);
		switch (result.status()) {
			case ABSENT -> {
				return;
			}
			case CONFLICT -> {
				failed.add(new FailedUpdate(path, FailedReason.PROPERTY_EXISTS));
				return;
			}
			case NOT_REWRITABLE -> {
				failed.add(new FailedUpdate(path, FailedReason.NOT_REWRITABLE));
				return;
			}
			case RENAMED -> {
				// Written below.
			}
		}
		if (dryRun) {
			updates.add(new PropertyUpdate(path, null));
			return;
		}
		try {
			byte[] updated = TextCodec.encode(result.text(), decoded.hadBom());
			this.fs.atomicWrite(note.disk(), updated);
			FileEntry entry = this.files.indexWritten(note, updated);
			updates.add(new PropertyUpdate(entry.path(), entry.version()));
			entries.add(entry);
			written.add(note);
		}
		catch (IOException ex) {
			logger.warn("Could not rename a property in {}: {}", path, ex.toString());
			failed.add(new FailedUpdate(path, FailedReason.IO_ERROR));
		}
	}

	private void flushPending() {
		try {
			this.batcher.flush();
		}
		catch (CommitFailedException ex) {
			logger.warn("Pending changes could not be committed before a property rename: {}", ex.getMessage());
		}
	}

	private ApiPath existing(String path) {
		String disk = this.index.diskPath(path);
		return new ApiPath(path, (disk != null) ? disk : path);
	}

}
