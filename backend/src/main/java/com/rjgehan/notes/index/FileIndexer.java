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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Builds {@link IndexedFile}s: text kinds within their size limit are hashed (their version), notes are decoded and
 * parsed; binary and over-size files are described by size and mtime only (DESIGN §4.2, §5.4). A text file that a
 * {@link DocumentIndexer} supports is decoded and handed to it, and what it returns is indexed like a note's body.
 */
@Component
public class FileIndexer {

	private static final Logger logger = LoggerFactory.getLogger(FileIndexer.class);

	private final VaultFs fs;

	private final FileKinds kinds;

	private final List<DocumentIndexer> documents;

	public FileIndexer(VaultFs fs, FileKinds kinds) {
		this(fs, kinds, List.of());
	}

	public FileIndexer(VaultFs fs, FileKinds kinds, List<DocumentIndexer> documents) {
		this.fs = fs;
		this.kinds = kinds;
		this.documents = List.copyOf(documents);
	}

	@Autowired
	public FileIndexer(VaultFs fs, FileKinds kinds, ObjectProvider<DocumentIndexer> documents) {
		this(fs, kinds, documents.orderedStream().toList());
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
				&& this.kinds.textLimit(path) == this.kinds.textLimit(other)
				&& documentIndexer(path) == documentIndexer(other);
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
			FileRecord record = new FileRecord(path, kind, bytes.length, mtime, version, List.of());
			DocumentParse.Parsed document = document(path, bytes);
			return (document != null) ? new IndexedFile(record, disk, document.text(), document.parse())
					: new IndexedFile(record, disk, null, null);
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		NoteParse parse = MarkdownScanner.scan(decoded.text(), decoded.hadBom(), decoded.lossy());
		FileRecord record = new FileRecord(path, kind, bytes.length, mtime, version, parse.aliases());
		return new IndexedFile(record, disk, decoded.text(), parse);
	}

	private DocumentParse.@Nullable Parsed document(String path, byte[] bytes) {
		DocumentIndexer indexer = documentIndexer(path);
		if (indexer == null) {
			return null;
		}
		TextCodec.Decoded decoded = TextCodec.decode(bytes);
		if (decoded.lossy()) {
			return null;
		}
		try {
			DocumentIndexer.Document document = indexer.index(path, decoded.text());
			return (document != null) ? DocumentParse.of(document) : null;
		}
		catch (RuntimeException ex) {
			// A defect in one document type must never stop the vault from being indexed.
			logger.warn("Cannot index {} as a document: {}", path, ex.toString());
			return null;
		}
	}

	/**
	 * A document's text with its links rewritten by its {@link DocumentIndexer} after a move, or null when no indexer
	 * handles both names or it cannot rewrite this text.
	 */
	public DocumentIndexer.@Nullable Rewritten rewriteDocument(String path, String newPath, String text,
			DocumentIndexer.LinkRewriter links) {
		DocumentIndexer indexer = documentIndexer(path);
		if (indexer == null || indexer != documentIndexer(newPath)) {
			return null;
		}
		try {
			return indexer.rewriteLinks(path, text, links);
		}
		catch (RuntimeException ex) {
			logger.warn("Cannot rewrite the links of {}: {}", path, ex.toString());
			return null;
		}
	}

	private @Nullable DocumentIndexer documentIndexer(String path) {
		for (DocumentIndexer indexer : this.documents) {
			if (indexer.supports(path)) {
				return indexer;
			}
		}
		return null;
	}

}
