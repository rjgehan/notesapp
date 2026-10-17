package com.rjgehan.notes.index;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * Lets a structured text type (a {@code .tasks} list today; sheets, drawings and canvases later) feed full-text
 * search, backlinks and tags without teaching {@link MarkdownScanner} its format (DESIGN §6.8). A Spring bean that
 * implements it is picked up by {@link FileIndexer}, which calls it whenever a file it {@link #supports} is indexed:
 * at startup, after an app write, and when the watcher or the rescan sees an external change.
 * <p>
 * The indexer renders what is searchable as Markdown {@linkplain Document#blocks() blocks}; each block is scanned with
 * the note rules on its own (so a code fence or a {@code %%} comment opened in one block never hides the next) and
 * the blocks, joined with newlines, become the document's search text. Their {@code [[wikilinks]]}, Markdown links and
 * {@code #tags} become the file's backlinks and tags exactly as they would in a note. Those links point into the
 * search text, not the file, so a rename never rewrites them (the move reports the file as {@code not-rewritable}),
 * and the file is never offered for unlinked mentions.
 */
public interface DocumentIndexer {

	/** True for the files this indexer understands, typically by extension. */
	boolean supports(String path);

	/**
	 * What to index for a file, or null when its text cannot be read in this format (it is then listed and served,
	 * but not content-indexed). Called outside every lock, possibly on several threads at once.
	 */
	@Nullable Document index(String path, String text);

	/** The document's searchable content as independent Markdown blocks, such as one per task. */
	record Document(List<String> blocks) {
	}

}
