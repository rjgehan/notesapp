package com.rjgehan.notes.index;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * The link rewrites a move needs (DESIGN §5.6), computed from the pre-move index: inbound links to moved files,
 * links inside moved notes whose resolution would change, and links elsewhere that the moved files would otherwise
 * hijack.
 */
public record MovePlan(List<NoteRewrite> rewrites) {

	public static final MovePlan EMPTY = new MovePlan(List.of());

	/**
	 * One splice: {@code [targetFrom, targetTo)} is replaced by {@code replacement}, provided the whole link
	 * {@code [from, to)} still reads {@code raw}. Offsets are UTF-16 indexes into the BOM-stripped text.
	 */
	public record Edit(int from, int to, String raw, int targetFrom, int targetTo, String replacement) {
	}

	/**
	 * The rewrites of one note. {@code source} is its path before the move, {@code target} after it; {@code version}
	 * is the version the plan was computed from. {@code notRewritable} is set when a link that needed a rewrite cannot
	 * be spliced safely (a frontmatter link whose source text differs from its parsed value). {@code document} is the
	 * whole new text of a file indexed through a {@link DocumentIndexer}, which rewrote it, instead of {@code edits}.
	 */
	public record NoteRewrite(String source, String target, String version, boolean lossy, List<Edit> edits,
			boolean notRewritable, DocumentIndexer.@Nullable Rewritten document) {

		public NoteRewrite(String source, String target, String version, boolean lossy, List<Edit> edits,
				boolean notRewritable) {
			this(source, target, version, lossy, edits, notRewritable, null);
		}

	}

}
