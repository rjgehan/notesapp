package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import com.rjgehan.notes.api.dto.TextRange;

/**
 * Turns a {@link DocumentIndexer.Document} into the text and {@link NoteParse} the index keeps for it: each block is
 * scanned as a Markdown fragment on its own, and the results are joined with offsets and lines shifted. Links are not
 * {@code rewritable}, because their offsets point into this search text rather than the file.
 */
public final class DocumentParse {

	/** The search text and its parse. */
	public record Parsed(String text, NoteParse parse) {
	}

	private DocumentParse() {
	}

	public static Parsed of(DocumentIndexer.Document document) {
		StringBuilder text = new StringBuilder();
		List<TagOcc> tags = new ArrayList<>();
		List<HeadingOcc> headings = new ArrayList<>();
		List<LinkOcc> links = new ArrayList<>();
		List<String> blockIds = new ArrayList<>();
		List<Integer> lineStarts = new ArrayList<>();
		List<TextRange> excluded = new ArrayList<>();
		List<TextRange> linkSpans = new ArrayList<>();
		int line = 0;
		for (String block : document.blocks()) {
			if (text.length() > 0) {
				text.append('\n');
			}
			int base = text.length();
			// Blocks are single paragraphs of the document; a stray \r would end up in offsets.
			String content = block.replace("\r\n", "\n").replace('\r', '\n');
			text.append(content);
			NoteParse parse = MarkdownScanner.scanFragment(content);
			for (int start : parse.lineStarts()) {
				lineStarts.add(base + start);
			}
			for (TagOcc tag : parse.tags()) {
				tags.add(new TagOcc(tag.tag(), tag.line() + line, tag.from() + base, tag.to() + base, false));
			}
			for (HeadingOcc heading : parse.headings()) {
				headings.add(new HeadingOcc(heading.level(), heading.text(), heading.line() + line));
			}
			for (LinkOcc link : parse.links()) {
				links.add(new LinkOcc(link.raw(), link.target(), link.subpath(), link.display(), link.embed(),
						link.style(), link.angle(), link.line() + line, link.from() + base, link.to() + base,
						link.targetFrom() + base, link.targetTo() + base, false, false, LinkOcc.Quoting.BODY));
			}
			blockIds.addAll(parse.blockIds());
			parse.excluded().forEach((range) -> excluded.add(shift(range, base)));
			parse.linkSpans().forEach((range) -> linkSpans.add(shift(range, base)));
			line += parse.lineStarts().length;
		}
		if (lineStarts.isEmpty()) {
			lineStarts.add(0);
		}
		int[] starts = lineStarts.stream().mapToInt(Integer::intValue).toArray();
		NoteParse parse = new NoteParse(null, null, List.of(), List.copyOf(tags), List.copyOf(headings),
				List.copyOf(links), List.copyOf(blockIds), starts, List.copyOf(excluded), List.copyOf(linkSpans),
				false, false);
		return new Parsed(text.toString(), parse);
	}

	/**
	 * A note with a document's blocks appended (a note that a {@link DocumentIndexer} supports too, such as an
	 * {@code .excalidraw.md} drawing). The blocks start on the line after the note's text, so search, backlinks and
	 * tags see them, while what the note's own text decides stays the note's: frontmatter, aliases, headings (the
	 * outline) and block ids. No file offset corresponds to the appended part, so its links are not rewritable and it
	 * is excluded from unlinked mentions, whose Link action edits the file.
	 */
	public static Parsed supplement(String noteText, NoteParse note, DocumentIndexer.Document document) {
		Parsed extra = of(document);
		String separator = (noteText.isEmpty() || noteText.endsWith("\n")) ? "" : "\n";
		int base = noteText.length() + separator.length();
		String text = noteText + separator + extra.text();
		int[] noteStarts = note.lineStarts();
		// A note that ends with a line break already has its last, empty line where the blocks start.
		int line = (noteStarts[noteStarts.length - 1] == base) ? noteStarts.length - 1 : noteStarts.length;
		int[] extraStarts = extra.parse().lineStarts();
		int[] starts = Arrays.copyOf(noteStarts, line + extraStarts.length);
		for (int i = 0; i < extraStarts.length; i++) {
			starts[line + i] = extraStarts[i] + base;
		}
		List<TagOcc> tags = new ArrayList<>(note.tags());
		for (TagOcc tag : extra.parse().tags()) {
			tags.add(new TagOcc(tag.tag(), tag.line() + line, tag.from() + base, tag.to() + base, false));
		}
		List<LinkOcc> links = new ArrayList<>(note.links());
		for (LinkOcc link : extra.parse().links()) {
			links.add(new LinkOcc(link.raw(), link.target(), link.subpath(), link.display(), link.embed(), link.style(),
					link.angle(), link.line() + line, link.from() + base, link.to() + base, link.targetFrom() + base,
					link.targetTo() + base, false, false, LinkOcc.Quoting.BODY));
		}
		List<TextRange> excluded = new ArrayList<>(note.excluded());
		excluded.add(new TextRange(base, text.length()));
		List<TextRange> linkSpans = new ArrayList<>(note.linkSpans());
		extra.parse().linkSpans().forEach((range) -> linkSpans.add(shift(range, base)));
		NoteParse parse = new NoteParse(note.frontmatter(), note.frontmatterError(), note.aliases(), List.copyOf(tags),
				note.headings(), List.copyOf(links), note.blockIds(), starts, List.copyOf(excluded),
				List.copyOf(linkSpans), note.hadBom(), note.lossy());
		return new Parsed(text, parse);
	}

	private static TextRange shift(TextRange range, int base) {
		return new TextRange(range.from() + base, range.to() + base);
	}

}
