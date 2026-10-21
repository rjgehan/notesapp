package com.rjgehan.notes.index;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * Lets a structured text type ({@code .tasks} lists, Excalidraw drawings, {@code .sheet} spreadsheets; canvases later)
 * feed full-text search, backlinks and tags without teaching {@link MarkdownScanner} its format (DESIGN §6.8). A Spring
 * bean that implements it is picked up by {@link FileIndexer}, which calls the first one that {@link #supports} a file
 * whenever it indexes it: at startup, after an app write, and when the watcher or the rescan sees an external change.
 * No two indexers support the same name.
 * <p>
 * The indexer renders what is searchable as Markdown {@linkplain Document#blocks() blocks}; each block is scanned with
 * the note rules on its own (so a code fence or a {@code %%} comment opened in one block never hides the next) and
 * the blocks, joined with newlines, become the document's search text. Their {@code [[wikilinks]]}, Markdown links and
 * {@code #tags} become the file's backlinks and tags exactly as they would in a note. Those links point into the
 * search text, not the file, so a move cannot splice them: it asks the indexer to {@linkplain #rewriteLinks rewrite}
 * the document as a whole instead (an indexer that cannot, which is the default, has the file reported as
 * {@code not-rewritable}). The file is never offered for unlinked mentions.
 * <p>
 * An indexer may also support notes, such as an Obsidian Excalidraw {@code .excalidraw.md} drawing. Such a note is
 * scanned as a note, with its own rewritable links, and the blocks are a supplement for what its Markdown does not
 * show: they are appended to its search text with the same rules, and add no headings or block ids
 * ({@link DocumentParse#supplement}). A move splices the note's own links as usual and never calls
 * {@link #rewriteLinks} for it; the supplement's links are not rewritable.
 */
public interface DocumentIndexer {

	/** True for the files this indexer understands, typically by extension. */
	boolean supports(String path);

	/**
	 * What to index for a file, or null when its text cannot be read in this format (it is then listed and served,
	 * but not content-indexed). Called outside every lock, possibly on several threads at once.
	 */
	@Nullable Document index(String path, String text);

	/**
	 * The document's text after the files a move names have moved (DESIGN §5.6): each Markdown fragment it indexed
	 * goes through {@link LinkRewriter#markdown}, and each vault path it holds as data through
	 * {@link LinkRewriter#path}. Returns the new text with the number of links changed ({@code 0} with the same text
	 * when none needed a change), or null when this document cannot be rewritten (the move then reports it as
	 * {@code not-rewritable} and leaves it as it is). The default cannot. Called under the vault write lock, before
	 * the move, for files that are not notes and keep this indexer under their new name.
	 */
	default @Nullable Rewritten rewriteLinks(String path, String text, LinkRewriter links) {
		return null;
	}

	/** The document's searchable content as independent Markdown blocks, such as one per task. */
	record Document(List<String> blocks) {
	}

	/** Text after a rewrite, and how many links in it changed. */
	record Rewritten(String text, int links) {
	}

	/** How a move rewrites the links of one document: {@link VaultIndex#documentRewriter}. */
	interface LinkRewriter {

		/**
		 * A Markdown fragment of the document (one of its blocks) with its links rewritten as they would be in a note
		 * at the document's path, or null when one of them cannot be.
		 */
		@Nullable Rewritten markdown(String fragment);

		/** A vault path the document holds as data: the path the file it names moved to, or the path itself. */
		String path(String path);

	}

}
