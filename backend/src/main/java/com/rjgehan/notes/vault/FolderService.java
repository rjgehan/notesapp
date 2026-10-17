package com.rjgehan.notes.vault;

import java.io.IOException;
import java.util.List;

import com.rjgehan.notes.api.dto.FolderEntry;
import com.rjgehan.notes.api.dto.FolderResult;
import com.rjgehan.notes.api.dto.TreeResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/** Folder creation and the tree snapshot. */
@Service
public class FolderService {

	private static final Logger logger = LoggerFactory.getLogger(FolderService.class);

	private final VaultPaths paths;

	private final VaultLocks locks;

	private final VaultIndex index;

	private final FileService files;

	private final EventHub hub;

	public FolderService(VaultPaths paths, VaultLocks locks, VaultIndex index, FileService files, EventHub hub) {
		this.paths = paths;
		this.locks = locks;
		this.index = index;
		this.files = files;
		this.hub = hub;
	}

	/** {@code GET /api/tree}: the event position is read before the snapshot, so no change can fall between them. */
	public TreeResponse tree() {
		String eventId = this.hub.headEventId();
		VaultIndex.Tree tree = this.index.snapshotTree();
		return new TreeResponse(eventId, tree.folders(), tree.files());
	}

	/** {@code POST /api/folders}: creates the folder and any missing parents. */
	public FolderResult create(String apiPath, Identity identity, @Nullable String origin) throws IOException {
		ApiPath path = this.paths.resolve(apiPath, Mode.NEW);
		try (VaultLocks.Held held = this.locks.read(FileService.lockPaths(path))) {
			String nfc = path.nfc();
			if (this.index.isFolder(nfc) || this.index.file(nfc) != null) {
				throw NotesException.alreadyExists(nfc, nfc);
			}
			String variant = this.index.folderIgnoreCase(nfc);
			if (variant == null) {
				variant = this.index.fileIgnoreCase(nfc);
			}
			if (variant != null) {
				throw NotesException.caseCollision(nfc, variant);
			}
			List<String> created = this.files.ensureFolder(nfc, path.disk(), nfc);
			this.files.publishFolders(created, origin);
			logger.info("MKDIR {} client={} user={}", nfc, origin, identity.login());
			return new FolderResult(new FolderEntry(nfc, path.name()), created);
		}
	}

}
