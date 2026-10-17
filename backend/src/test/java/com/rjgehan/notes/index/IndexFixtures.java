package com.rjgehan.notes.index;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.Hashing;
import com.rjgehan.notes.vault.TextCodec;

/** Builds in-memory indexes for link tests. */
final class IndexFixtures {

	static final FileKinds KINDS = new FileKinds(TestProperties.forVault(Path.of("vault")));

	/** The fixture vault of API.md §15. */
	static final List<String> API_VAULT = List.of("Welcome.md", "Plan.md", "log.md", "v1.2 notes.md",
			"Projects/Plan.md", "Projects/Alpha/Spec.md", "Projects/Alpha/notes.md", "Archive/Spec.md",
			"Archive/2025/Old.md", "Attachments/pic.png", "Daily/2026-10-16.md", "Ideas/Plan B.md");

	private IndexFixtures() {
	}

	static VaultIndex index(List<String> paths) {
		VaultIndex index = new VaultIndex();
		for (String path : paths) {
			put(index, path);
		}
		return index;
	}

	static void put(VaultIndex index, String path) {
		index.put(file(path));
	}

	static IndexedFile file(String path) {
		return new IndexedFile(new FileRecord(path, KINDS.kindOf(path), 0, Instant.EPOCH, null, List.of()), path, null,
				null);
	}

	/** A parsed note, ready to be swapped in. */
	static IndexedFile note(String path, String text) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		byte[] bytes = TextCodec.encode(text, false);
		FileRecord record = new FileRecord(path, KINDS.kindOf(path), bytes.length, Instant.EPOCH,
				Hashing.blobId(bytes), parse.aliases());
		return new IndexedFile(record, path, text, parse);
	}

}
