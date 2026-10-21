package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * Reads the vault's {@code .tasks} files into a {@link TaskCatalog}. The index says which files exist and their
 * version; a file is parsed again only when its version differs from the cached {@link TaskSnapshot}, so a hand edit
 * picked up by the watcher or the rescan (or one still waiting for them: the disk is read, not the index) shows up
 * on the next read. Reads take no lock: a catalog is a snapshot, and every write re-reads its files under their locks.
 */
@Component
public class TaskStore {

	private static final Logger logger = LoggerFactory.getLogger(TaskStore.class);

	static final String EXTENSION = "tasks";

	private final VaultIndex index;

	private final VaultFs fs;

	private final FileKinds kinds;

	private final JsonMapper mapper;

	private final Map<String, TaskSnapshot> cache = new ConcurrentHashMap<>();

	public TaskStore(VaultIndex index, VaultFs fs, FileKinds kinds, JsonMapper mapper) {
		this.index = index;
		this.fs = fs;
		this.kinds = kinds;
		this.mapper = mapper;
	}

	static boolean isTaskFile(String path) {
		return EXTENSION.equals(PathNames.extensionOf(PathNames.nameOf(path)));
	}

	TaskCatalog catalog() {
		List<FileRecord> records = this.index.files((record) -> isTaskFile(record.path()));
		List<TaskSnapshot> snapshots = new ArrayList<>(records.size());
		Set<String> paths = new HashSet<>();
		for (FileRecord record : records) {
			paths.add(record.path());
			TaskSnapshot snapshot = snapshot(record);
			if (snapshot != null) {
				snapshots.add(snapshot);
			}
		}
		// Files deleted or moved away since they were cached.
		this.cache.keySet().retainAll(paths);
		return TaskCatalog.of(snapshots);
	}

	/** Remembers a file just written, so the next read needs no parse. */
	void remember(TaskSnapshot snapshot) {
		this.cache.put(snapshot.path(), snapshot);
	}

	JsonMapper mapper() {
		return this.mapper;
	}

	/** Reads and checks bytes from a {@code .tasks} file at {@code path}. */
	TaskSnapshot snapshot(String path, byte[] bytes) {
		String version = Hashing.blobId(bytes);
		try {
			return TaskSnapshot.of(path, version, TaskFile.parse(bytes, this.mapper));
		}
		catch (TaskFile.MalformedException ex) {
			return TaskSnapshot.unusable(path, version, ex.getMessage());
		}
	}

	private @Nullable TaskSnapshot snapshot(FileRecord record) {
		String path = record.path();
		if (record.version() == null) {
			return TaskSnapshot.unusable(path, "",
					"larger than the text limit of " + this.kinds.textLimit(path) + " bytes");
		}
		TaskSnapshot cached = this.cache.get(path);
		if (cached != null && cached.version().equals(record.version())) {
			return cached;
		}
		String disk = this.index.diskPath(path);
		try {
			byte[] bytes = this.fs.readBytes((disk != null) ? disk : path);
			if (bytes.length > this.kinds.textLimit(path)) {
				return TaskSnapshot.unusable(path, "",
						"larger than the text limit of " + this.kinds.textLimit(path) + " bytes");
			}
			TaskSnapshot snapshot = snapshot(path, bytes);
			this.cache.put(path, snapshot);
			return snapshot;
		}
		catch (IOException ex) {
			// Deleted or moved since the index listed it; the watcher or the rescan will catch up.
			logger.debug("Cannot read {}: {}", path, ex.toString());
			return null;
		}
	}

}
