package com.rjgehan.notes.vault;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectInserter;

/**
 * Version tokens: the git blob id of a file's exact bytes, {@code sha1("blob " + length + "\0" + bytes)} as 40
 * lowercase hex characters (DESIGN §5.4). It is the id JGit stores, so "is this version committed?" is one lookup.
 */
public final class Hashing {

	private Hashing() {
	}

	public static String blobId(byte[] bytes) {
		try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter()) {
			return formatter.idFor(Constants.OBJ_BLOB, bytes).name();
		}
	}

	/** Hashes a file without loading it into memory. */
	public static String blobId(Path file) throws IOException {
		long size = Files.size(file);
		try (ObjectInserter.Formatter formatter = new ObjectInserter.Formatter();
				InputStream in = Files.newInputStream(file)) {
			return formatter.idFor(Constants.OBJ_BLOB, size, in).name();
		}
	}

}
