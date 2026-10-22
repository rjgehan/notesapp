package com.rjgehan.notes.publish;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.LinkStyle;
import com.rjgehan.notes.api.dto.TextRange;
import com.rjgehan.notes.index.LinkOcc;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.NoteParse;
import com.rjgehan.notes.vault.PathNames;
import org.commonmark.Extension;
import org.commonmark.ext.autolink.AutolinkExtension;
import org.commonmark.ext.footnotes.FootnotesExtension;
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.ext.heading.anchor.HeadingAnchorExtension;
import org.commonmark.ext.heading.anchor.IdGenerator;
import org.commonmark.ext.task.list.items.TaskListItemsExtension;
import org.commonmark.node.AbstractVisitor;
import org.commonmark.node.BlockQuote;
import org.commonmark.node.Code;
import org.commonmark.node.FencedCodeBlock;
import org.commonmark.node.HardLineBreak;
import org.commonmark.node.HtmlBlock;
import org.commonmark.node.HtmlInline;
import org.commonmark.node.Image;
import org.commonmark.node.Link;
import org.commonmark.node.Node;
import org.commonmark.node.Paragraph;
import org.commonmark.node.SoftLineBreak;
import org.commonmark.node.StrongEmphasis;
import org.commonmark.node.Text;
import org.commonmark.parser.Parser;
import org.commonmark.renderer.NodeRenderer;
import org.commonmark.renderer.html.HtmlNodeRendererContext;
import org.commonmark.renderer.html.HtmlRenderer;
import org.commonmark.renderer.html.HtmlWriter;
import org.jspecify.annotations.Nullable;

/**
 * Turns one note into the static HTML of a published snapshot (DESIGN §5.28). The output never reveals what was not
 * chosen for publishing:
 * <ul>
 * <li>frontmatter, {@code %% %%} and {@code <!-- -->} comments, raw HTML (except {@code <br>}) and code blocks that
 * show vault data ({@code query}, {@code dataview}, {@code tasks}…) are left out;</li>
 * <li>a link to a note becomes a link only when that note is published (to its {@code /p/<slug>}); any other internal
 * link is plain text (its alias, or the target's name without its folder), and an embed of a note that is not
 * published is left out;</li>
 * <li>only images, audio and video the note embeds become snapshot assets; any other URL must be {@code http},
 * {@code https} or {@code mailto}, or the link is plain text.</li>
 * </ul>
 * Internal links are rewritten in the Markdown source, using the offsets of {@link MarkdownScanner}, into links to a
 * per-render marker scheme that only the link and image renderers here understand.
 */
public final class PublishRenderer {

	/** What the renderer needs from the vault and the published set. */
	public interface Context {

		/** The vault path a link target written in this note resolves to, or null. */
		@Nullable String resolve(String target);

		/** The kind of an indexed file. */
		FileKind kindOf(String path);

		/** The slug of a published note (this note included), or null when it is not published. */
		@Nullable String slugOf(String path);

		/** The title a published note is shown with, or null when it is not published. */
		@Nullable String titleOf(String path);

		/**
		 * The snapshot asset name for an image, audio or video file this note embeds, or null when it cannot be part of
		 * the snapshot (too large, unreadable).
		 */
		@Nullable String asset(String path);

	}

	/** Fenced code blocks whose content is a query over the vault, not text meant for readers. */
	private static final Set<String> VAULT_DATA_BLOCKS = Set.of("query", "dataview", "dataviewjs", "tasks", "base",
			"bases");

	private static final Pattern SIZE_HINT = Pattern.compile("\\d+(?:x\\d+)?");

	private static final Pattern BLOCK_ID_SUFFIX = Pattern.compile("(?:^|\\s)\\^[A-Za-z0-9-]+\\s*$");

	private static final Pattern CALLOUT = Pattern.compile("^\\[!([A-Za-z0-9_-]+)\\][+-]?\\s*");

	/** An inline encrypted section of Meld Encrypt (ROADMAP item 27); an unclosed one runs to the end. */
	private static final Pattern ENCRYPTED = Pattern.compile("(?s)\\x{1F510}[\\x{3B1}\\x{3B2}].*?(?:\\x{1F510}|\\z)");

	private static final String ENCRYPTED_PLACEHOLDER = "🔒 *encrypted*";

	private static final Pattern BR = Pattern.compile("(?i)<br\\s*/?>");

	private static final Set<String> SAFE_SCHEMES = Set.of("http", "https", "mailto");

	private static final List<Extension> EXTENSIONS = List.of(TablesExtension.create(),
			StrikethroughExtension.create(), TaskListItemsExtension.create(), FootnotesExtension.create(),
			AutolinkExtension.create(), HeadingAnchorExtension.create());

	private static final Parser PARSER = Parser.builder().extensions(EXTENSIONS).build();

	private static final SecureRandom RANDOM = new SecureRandom();

	private PublishRenderer() {
	}

	/** One embedded attachment of the snapshot. */
	record Media(String name, FileKind kind, @Nullable String width, @Nullable String height) {
	}

	/** The Markdown body as published HTML, for the note at {@code notePath} published as {@code slug}. */
	public static String renderBody(String notePath, String text, Context context) {
		String marker = "notesapp-publish-" + HexFormat.of().formatHex(randomBytes()) + ":";
		List<String> hrefs = new ArrayList<>();
		List<Media> media = new ArrayList<>();
		String source = rewrite(notePath, text, context, marker, hrefs, media);
		Node document = PARSER.parse(source);
		document.accept(new Cleanup());
		HtmlRenderer renderer = HtmlRenderer.builder()
			.extensions(EXTENSIONS)
			.escapeHtml(true)
			.sanitizeUrls(true)
			.nodeRendererFactory((ctx) -> new SafeRenderer(ctx, marker, hrefs, media, "/p/" + context.slugOf(notePath) + "/"))
			.build();
		return renderer.render(document);
	}

	private static byte[] randomBytes() {
		byte[] bytes = new byte[12];
		RANDOM.nextBytes(bytes);
		return bytes;
	}

	// ------------------------------------------------------------------ source rewriting

	private record Edit(int from, int to, String replacement) {
	}

	static String rewrite(String notePath, String text, Context context, String marker, List<String> hrefs,
			List<Media> media) {
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		int bodyStart = (parse.frontmatter() != null) ? parse.frontmatter().to() : 0;
		List<Edit> edits = new ArrayList<>();
		for (TextRange zone : parse.excluded()) {
			if (zone.from() >= bodyStart && (text.startsWith("%%", zone.from()) || text.startsWith("<!--", zone.from()))) {
				edits.add(new Edit(zone.from(), zone.to(), ""));
			}
		}
		// Encrypted sections (ROADMAP item 27, Meld Encrypt's "🔐β 💡hint💡<ciphertext> 🔐") are never published, not
		// even their hint: each becomes a placeholder. Those inside %% %% went with the comment above.
		Matcher encrypted = ENCRYPTED.matcher(text);
		encrypted.region(bodyStart, text.length());
		while (encrypted.find()) {
			if (!inCode(parse.excluded(), text, encrypted.start())) {
				edits.add(new Edit(encrypted.start(), encrypted.end(), ENCRYPTED_PLACEHOLDER));
			}
		}
		for (LinkOcc link : parse.links()) {
			if (link.inFrontmatter() || link.from() < bodyStart) {
				continue;
			}
			edits.add(new Edit(link.from(), link.to(), replacement(notePath, link, context, marker, hrefs, media)));
		}
		edits.sort(Comparator.comparingInt(Edit::from));
		StringBuilder out = new StringBuilder(text.length());
		int position = bodyStart;
		for (Edit edit : edits) {
			if (edit.from() < position) {
				continue;
			}
			out.append(text, position, edit.from()).append(edit.replacement());
			position = edit.to();
		}
		out.append(text, Math.max(position, bodyStart), text.length());
		return out.toString();
	}

	/** True inside a code span, a fenced block or math, where the text is shown as written. */
	private static boolean inCode(List<TextRange> zones, String text, int position) {
		for (TextRange zone : zones) {
			if (zone.from() <= position && position < zone.to() && !text.startsWith("%%", zone.from())
					&& !text.startsWith("<!--", zone.from())) {
				return true;
			}
		}
		return false;
	}

	private static String replacement(String notePath, LinkOcc link, Context context, String marker,
			List<String> hrefs, List<Media> media) {
		String resolved = context.resolve(link.target());
		boolean wiki = link.style() == LinkStyle.WIKI;
		if (link.embed()) {
			FileKind kind = (resolved != null) ? context.kindOf(resolved) : FileKind.OTHER;
			if (resolved != null && (kind == FileKind.IMAGE || kind == FileKind.AUDIO || kind == FileKind.VIDEO)) {
				String name = context.asset(resolved);
				if (name == null) {
					return "";
				}
				String display = link.display();
				String width = null;
				String height = null;
				String alt;
				if (wiki) {
					if (display != null && SIZE_HINT.matcher(display.strip()).matches()) {
						String[] size = display.strip().split("x");
						width = size[0];
						height = (size.length > 1) ? size[1] : null;
						alt = PathNames.basenameOf(PathNames.nameOf(resolved));
					}
					else {
						alt = (display != null) ? display : PathNames.basenameOf(PathNames.nameOf(resolved));
					}
					alt = escape(alt);
				}
				else {
					alt = (display != null) ? display : "";
				}
				media.add(new Media(name, kind, width, height));
				return "![" + alt + "](<" + marker + "m" + (media.size() - 1) + ">)";
			}
			if (resolved != null && kind == FileKind.NOTE && context.slugOf(resolved) != null) {
				String title = context.titleOf(resolved);
				hrefs.add(href(notePath, resolved, link.subpath(), context));
				return "[" + escape((title != null) ? title : PathNames.basenameOf(PathNames.nameOf(resolved))) + "](<"
						+ marker + "l" + (hrefs.size() - 1) + ">)";
			}
			// An embed shows another file's content, never its name: leave out what is not published.
			return "";
		}
		String text = wiki ? escape(wikiDisplay(link)) : nonNull(link.display());
		if (resolved == null || context.slugOf(resolved) == null) {
			return text;
		}
		hrefs.add(href(notePath, resolved, link.subpath(), context));
		return "[" + text + "](<" + marker + "l" + (hrefs.size() - 1) + ">)";
	}

	private static String href(String notePath, String resolved, @Nullable String subpath, Context context) {
		String anchor = anchor(subpath);
		if (resolved.equals(notePath)) {
			return (anchor != null) ? "#" + anchor : "#";
		}
		return "/p/" + context.slugOf(resolved) + ((anchor != null) ? "#" + anchor : "");
	}

	/** The id {@link HeadingAnchorExtension} gives the heading a subpath names, or null for a block or no subpath. */
	static @Nullable String anchor(@Nullable String subpath) {
		if (subpath == null || subpath.isBlank()) {
			return null;
		}
		String[] segments = subpath.split("#");
		String last = segments[segments.length - 1].strip();
		if (last.isEmpty() || last.startsWith("^")) {
			return null;
		}
		return IdGenerator.builder().build().generateId(last);
	}

	/** What Obsidian shows for a wikilink: its alias, or the target's name (no folder, no {@code .md}) and heading. */
	static String wikiDisplay(LinkOcc link) {
		if (link.display() != null) {
			return link.display();
		}
		String name = link.target().isEmpty() ? "" : PathNames.nameOf(link.target());
		if (PathNames.isMarkdown(name)) {
			name = PathNames.basenameOf(name);
		}
		String subpath = link.subpath();
		if (subpath == null || subpath.isBlank()) {
			return name;
		}
		List<String> parts = new ArrayList<>();
		if (!name.isEmpty()) {
			parts.add(name);
		}
		for (String segment : subpath.split("#")) {
			if (!segment.isBlank() && !segment.startsWith("^")) {
				parts.add(segment.strip());
			}
		}
		return parts.isEmpty() ? name : String.join(" > ", parts);
	}

	/** Backslash-escapes every ASCII punctuation character, so the text is literal Markdown. */
	static String escape(String text) {
		StringBuilder out = new StringBuilder(text.length() + 8);
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if (c == '\n' || c == '\r') {
				out.append(' ');
				continue;
			}
			if ((c >= 0x21 && c <= 0x2F) || (c >= 0x3A && c <= 0x40) || (c >= 0x5B && c <= 0x60)
					|| (c >= 0x7B && c <= 0x7E)) {
				out.append('\\');
			}
			out.append(c);
		}
		return out.toString();
	}

	private static String nonNull(@Nullable String text) {
		return (text != null) ? text : "";
	}

	// ------------------------------------------------------------------ tree cleanup

	/** Removes vault-data code blocks and block ids; turns callout markers into a bold title. */
	private static final class Cleanup extends AbstractVisitor {

		@Override
		public void visit(FencedCodeBlock block) {
			String info = (block.getInfo() != null) ? block.getInfo().strip() : "";
			String language = info.split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
			if (VAULT_DATA_BLOCKS.contains(language)) {
				block.unlink();
			}
		}

		@Override
		public void visit(Text text) {
			Node next = text.getNext();
			if (next == null || next instanceof SoftLineBreak || next instanceof HardLineBreak) {
				Matcher m = BLOCK_ID_SUFFIX.matcher(text.getLiteral());
				if (m.find()) {
					text.setLiteral(text.getLiteral().substring(0, m.start()));
				}
			}
		}

		@Override
		public void visit(BlockQuote quote) {
			if (quote.getFirstChild() instanceof Paragraph paragraph && paragraph.getFirstChild() instanceof Text first) {
				Matcher m = CALLOUT.matcher(first.getLiteral());
				if (m.find()) {
					String rest = first.getLiteral().substring(m.end());
					boolean titled = !rest.isBlank() || !(first.getNext() == null || first.getNext() instanceof SoftLineBreak);
					StrongEmphasis title = new StrongEmphasis();
					if (titled) {
						first.setLiteral(rest);
						first.insertBefore(title);
						title.appendChild(first);
						Node sibling = title.getNext();
						while (sibling != null && !(sibling instanceof SoftLineBreak)) {
							Node after = sibling.getNext();
							title.appendChild(sibling);
							sibling = after;
						}
					}
					else {
						String type = m.group(1).toLowerCase(Locale.ROOT);
						first.setLiteral(Character.toUpperCase(type.charAt(0)) + type.substring(1));
						first.insertBefore(title);
						title.appendChild(first);
					}
					// The title is a line of its own, as in Obsidian.
					if (title.getNext() instanceof SoftLineBreak soft) {
						soft.insertBefore(new HardLineBreak());
						soft.unlink();
					}
				}
			}
			visitChildren(quote);
		}

	}

	// ------------------------------------------------------------------ rendering

	/** Links, images and raw HTML under the publishing rules. */
	private static final class SafeRenderer implements NodeRenderer {

		private final HtmlNodeRendererContext context;

		private final HtmlWriter html;

		private final String marker;

		private final List<String> hrefs;

		private final List<Media> media;

		private final String assetBase;

		SafeRenderer(HtmlNodeRendererContext context, String marker, List<String> hrefs, List<Media> media,
				String assetBase) {
			this.assetBase = assetBase;
			this.context = context;
			this.html = context.getWriter();
			this.marker = marker;
			this.hrefs = hrefs;
			this.media = media;
		}

		@Override
		public Set<Class<? extends Node>> getNodeTypes() {
			return Set.of(Link.class, Image.class, HtmlBlock.class, HtmlInline.class);
		}

		@Override
		public void render(Node node) {
			switch (node) {
				case Link link -> renderLink(link);
				case Image image -> renderImage(image);
				case HtmlInline inline -> {
					if (BR.matcher(inline.getLiteral().strip()).matches()) {
						this.html.tag("br", Map.of(), true);
					}
				}
				default -> {
					// HTML blocks are never published.
				}
			}
		}

		private void renderLink(Link link) {
			String href = safeHref(link.getDestination());
			if (href == null) {
				renderChildren(link);
				return;
			}
			Map<String, String> attributes = new LinkedHashMap<>();
			attributes.put("href", href);
			if (link.getTitle() != null) {
				attributes.put("title", link.getTitle());
			}
			if (!href.startsWith("/") && !href.startsWith("#")) {
				attributes.put("rel", "nofollow noopener noreferrer");
			}
			this.html.tag("a", attributes);
			renderChildren(link);
			this.html.tag("/a");
		}

		private @Nullable String safeHref(String destination) {
			if (destination.startsWith(this.marker)) {
				String id = destination.substring(this.marker.length());
				if (id.startsWith("l")) {
					int index = parseIndex(id.substring(1));
					return (index >= 0 && index < this.hrefs.size()) ? this.hrefs.get(index) : null;
				}
				return null;
			}
			if (destination.startsWith("#") && destination.length() > 1) {
				return destination;
			}
			int colon = destination.indexOf(':');
			if (colon > 0) {
				String scheme = destination.substring(0, colon).toLowerCase(Locale.ROOT);
				if (SAFE_SCHEMES.contains(scheme) && (!scheme.startsWith("http") || destination.startsWith("//", colon + 1))) {
					return destination;
				}
			}
			return null;
		}

		private void renderImage(Image image) {
			String destination = image.getDestination();
			String alt = altText(image);
			if (destination.startsWith(this.marker + "m")) {
				int index = parseIndex(destination.substring(this.marker.length() + 1));
				if (index < 0 || index >= this.media.size()) {
					return;
				}
				Media item = this.media.get(index);
				String src = this.assetBase + item.name();
				Map<String, String> attributes = new LinkedHashMap<>();
				attributes.put("src", src);
				switch (item.kind()) {
					case AUDIO, VIDEO -> {
						attributes.put("controls", "");
						attributes.put("preload", "metadata");
						if (item.width() != null && item.kind() == FileKind.VIDEO) {
							attributes.put("width", item.width());
						}
						String tag = (item.kind() == FileKind.AUDIO) ? "audio" : "video";
						this.html.tag(tag, attributes);
						this.html.tag("/" + tag);
					}
					default -> {
						attributes.put("alt", alt);
						attributes.put("loading", "lazy");
						if (item.width() != null) {
							attributes.put("width", item.width());
						}
						if (item.height() != null) {
							attributes.put("height", item.height());
						}
						this.html.tag("img", attributes, true);
					}
				}
				return;
			}
			String href = safeHref(destination);
			if (href != null && !href.startsWith("#") && !destination.startsWith(this.marker)) {
				// External images are linked, not loaded: the page loads nothing from elsewhere.
				Map<String, String> attributes = new LinkedHashMap<>();
				attributes.put("href", href);
				attributes.put("rel", "nofollow noopener noreferrer");
				this.html.tag("a", attributes);
				this.html.text(alt.isBlank() ? href : alt);
				this.html.tag("/a");
			}
		}

		private void renderChildren(Node parent) {
			Node child = parent.getFirstChild();
			while (child != null) {
				Node next = child.getNext();
				this.context.render(child);
				child = next;
			}
		}

		private static int parseIndex(String digits) {
			try {
				return Integer.parseInt(digits);
			}
			catch (NumberFormatException ex) {
				return -1;
			}
		}

		private static String altText(Node node) {
			StringBuilder out = new StringBuilder();
			node.accept(new AbstractVisitor() {
				@Override
				public void visit(Text text) {
					out.append(text.getLiteral());
				}

				@Override
				public void visit(Code code) {
					out.append(code.getLiteral());
				}

				@Override
				public void visit(SoftLineBreak softLineBreak) {
					out.append(' ');
				}
			});
			return out.toString();
		}

	}

}
