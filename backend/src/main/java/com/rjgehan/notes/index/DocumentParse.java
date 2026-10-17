package com.rjgehan.notes.index;

import java.util.ArrayList;
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

	private static TextRange shift(TextRange range, int base) {
		return new TextRange(range.from() + base, range.to() + base);
	}

}
