package com.rjgehan.notes.index;

import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * One visible file. {@code version} is set only for text kinds within their size limit; {@code aliases} only for
 * notes.
 */
public record FileRecord(String path, FileKind kind, long size, Instant mtime, @Nullable String version,
		List<String> aliases) {

	/** The same file under another path (a move keeps size, mtime, version and aliases). */
	public FileRecord withPath(String newPath) {
		return new FileRecord(newPath, this.kind, this.size, this.mtime, this.version, this.aliases);
	}

	public FileEntry toEntry() {
		String name = PathNames.nameOf(this.path);
		return new FileEntry(this.path, name, PathNames.basenameOf(name), PathNames.extensionOf(name), this.kind,
				this.size, this.mtime, this.version, this.aliases);
	}

}
