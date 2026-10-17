package com.rjgehan.notes.index;

import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;

/**
 * A file read and parsed outside the index lock, ready to be swapped in. {@code text}, {@code parse} and the search
 * document are set only for notes within their size limit; {@code disk} is the repo-relative on-disk path.
 */
public record IndexedFile(FileRecord record, String disk, @Nullable String text, @Nullable NoteParse parse,
		SearchIndex.@Nullable Doc search) {

	/** Tokenizes a note for search here, on the calling thread, so the index lock is held only for the swap. */
	public IndexedFile(FileRecord record, String disk, @Nullable String text, @Nullable NoteParse parse) {
		this(record, disk, text, parse, (text != null && parse != null)
				? SearchIndex.Doc.of(PathNames.basenameOf(PathNames.nameOf(record.path())), text, parse) : null);
	}

	public String path() {
		return this.record.path();
	}

}
