package com.rjgehan.notes.index;

import java.io.IOException;
import java.nio.file.NoSuchFileException;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * Builds {@link IndexedFile}s: text kinds within their size limit are hashed (their version), notes are decoded and
 * parsed; binary and over-size files are described by size and mtime only (DESIGN §4.2, §5.4).
 */
@Component
public class FileIndexer {

	private final VaultFs fs;

	private final FileKinds kinds;

	public FileIndexer(VaultFs fs, FileKinds kinds) {
		this.fs = fs;
		this.kinds = kinds;
	}

	/** Reads the file from disk. */
	public IndexedFile load(String path, String disk) throws IOException {
		BasicFileAttributes attributes = this.fs.attributes(disk);
		if (attributes == null || !attributes.isRegularFile()) {
			throw new NoSuchFileException(disk);
		}
		byte[] bytes = null;
		if (isIndexedText(path, attributes.size())) {
			bytes = this.fs.readBytes(disk);
		}
		return build(path, disk, bytes, attributes.size(), attributes.lastModifiedTime().toInstant());
	}

	/** Uses bytes the caller has just written or read, so the file is not read again. */
	public IndexedFile fromBytes(String path, String disk, byte[] bytes, BasicFileAttributes attributes) {
		Instant mtime = attributes.lastModifiedTime().toInstant();
		return build(path, disk, isIndexedText(path, bytes.length) ? bytes : null, bytes.length, mtime);
	}

	/** True for text kinds within their size limit: these have a version and, for notes, a parse. */
	public boolean isIndexedText(String path, long size) {
		return this.kinds.kindOf(path).isText() && size <= this.kinds.textLimit(path);
	}

	/** The kind of a file name or path, from its extension. */
	public FileKind kindOf(String path) {
		return this.kinds.kindOf(path);
	}

	/**
	 * True when both names are indexed the same way (same kind and text limit), so a file renamed from one to the
	 * other keeps its record; otherwise it must be indexed again from disk.
	 */
	public boolean indexesAlike(String path, String other) {
		return this.kinds.kindOf(path) == this.kinds.kindOf(other)
				&& this.kinds.textLimit(path) == this.kinds.textLimit(other);
	}

	/**
	 * True when {@code record} was built for a file of this name and size: its kind matches the name, and it has a
	 * version exactly when the file is indexed text.
	 */
	public boolean matches(FileRecord record, long size) {
		return record.kind() == this.kinds.kindOf(record.path())
				&& (record.version() != null) == isIndexedText(record.path(), size);
	}

	private IndexedFile build(String path, String disk, byte @Nullable [] bytes, long size, Instant mtime) {
		FileKind kind = this.kinds.kindOf(path);
		if (bytes == null) {
			return new IndexedFile(new FileRecord(path, kind, size, mtime, null, List.of()), disk, null, null);
		}
		String version = Hashing.blobId(bytes);
		if (kind != FileKind.NOTE) {
			return new IndexedFile(new FileRecord(path, kind, bytes.length, mtime, version, List.of()), disk, null,
					null);
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		NoteParse parse = MarkdownScanner.scan(decoded.text(), decoded.hadBom(), decoded.lossy());
		FileRecord record = new FileRecord(path, kind, bytes.length, mtime, version, parse.aliases());
		return new IndexedFile(record, disk, decoded.text(), parse);
	}

}
