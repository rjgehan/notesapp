package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.BacklinkGroup;
import com.rjgehan.notes.api.dto.BacklinksResponse;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.HeadingInfo;
import com.rjgehan.notes.api.dto.Mention;
import com.rjgehan.notes.api.dto.NoteMeta;
import com.rjgehan.notes.api.dto.OutgoingLink;
import com.rjgehan.notes.api.dto.ResolveResponse;
import com.rjgehan.notes.api.dto.ResolvedLink;
import com.rjgehan.notes.api.dto.TextRange;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultPaths;
import com.rjgehan.notes.vault.VaultPaths.Mode;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Read-only views of notes and links (API.md §11): parsed metadata, linked and unlinked backlinks, and link
 * resolution with the same algorithm the server uses for backlinks and rewrites.
 */
@Service
public class NoteService {

	/** The longest backlink context line. */
	public static final int CONTEXT_WIDTH = 240;

	/** At most this many source notes are listed under unlinked mentions. */
	public static final int MAX_UNLINKED_GROUPS = 200;

	public static final int MAX_RESOLVE_TARGETS = 500;

	private final VaultPaths paths;

	private final VaultIndex index;

	private final FileKinds kinds;

	private final SettingsService settings;

	public NoteService(VaultPaths paths, VaultIndex index, FileKinds kinds, SettingsService settings) {
		this.paths = paths;
		this.index = index;
		this.kinds = kinds;
		this.settings = settings;
	}

	/** {@code GET /api/notes/meta}: notes only ({@code 409 type-mismatch} with {@code expected: "note"} otherwise). */
	public NoteMeta meta(String apiPath) {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		VaultIndex.NoteView view = this.index.noteView(path.nfc());
		if (view == null || this.kinds.kindOf(path.nfc()) != FileKind.NOTE) {
			FileRecord file = this.index.file(path.nfc());
			if (file == null && !this.index.isFolder(path.nfc())) {
				throw NotesException.notFound(path.nfc());
			}
			if (file == null || file.kind() != FileKind.NOTE) {
				throw NotesException.typeMismatch(path.nfc(), "note", "Not a note: " + path.nfc());
			}
			long limit = this.kinds.textLimit(path.nfc());
			throw NotesException.tooLarge(limit, "The note is larger than the text limit and is not indexed");
		}
		NoteRecord note = view.note();
		NoteParse parse = note.parse();
		Frontmatter frontmatter = parse.frontmatter();
		List<HeadingInfo> headings = parse.headings()
			.stream()
			.map((heading) -> new HeadingInfo(heading.level(), heading.text(), heading.line()))
			.toList();
		List<OutgoingLink> links = new ArrayList<>(view.links().size());
		for (LinkGraph.Resolved resolved : view.links()) {
			LinkOcc occ = resolved.occ();
			links.add(new OutgoingLink(occ.raw(), occ.target(), occ.subpath(), occ.display(), occ.embed(), occ.style(),
					occ.line(), occ.from(), occ.to(), occ.inFrontmatter(), resolved.target()));
		}
		return new NoteMeta(note.path(), note.version(), (frontmatter != null) ? frontmatter.data() : null,
				parse.frontmatterError(), parse.aliases(), parse.distinctTags(), headings, parse.blockIds(), links);
	}

	/**
	 * {@code GET /api/notes/backlinks}: notes linking to any file, newest first, and on request the unlinked mentions
	 * of a note's basename and aliases.
	 */
	public BacklinksResponse backlinks(String apiPath, boolean unlinked) {
		ApiPath path = this.paths.resolve(apiPath, Mode.EXISTING);
		FileRecord target = this.index.file(path.nfc());
		if (target == null) {
			throw NotesException.notFound(path.nfc());
		}
		List<BacklinkGroup> linked = new ArrayList<>();
		for (VaultIndex.Backlink backlink : this.index.backlinks(path.nfc())) {
			NoteRecord source = backlink.source();
			List<Mention> mentions = new ArrayList<>();
			for (LinkOcc occ : backlink.links()) {
				mentions.add(mention(source, occ.line(), occ.from(), occ.to(), occ.raw()));
			}
			linked.add(new BacklinkGroup(source.path(), source.version(), mentions));
		}
		return new BacklinksResponse(path.nfc(), linked, unlinked ? unlinked(target) : null);
	}

	private List<BacklinkGroup> unlinked(FileRecord target) {
		if (target.kind() != FileKind.NOTE) {
			return List.of();
		}
		List<String> names = new ArrayList<>();
		names.add(PathNames.basenameOf(PathNames.nameOf(target.path())));
		names.addAll(target.aliases());
		List<String> usable = MentionFinder.usableNames(names);
		if (usable.isEmpty()) {
			return List.of();
		}
		FilesSettings files = this.settings.current().files();
		List<BacklinkGroup> groups = new ArrayList<>();
		for (VaultIndex.Candidate candidate : this.index.mentionCandidates(usable)) {
			NoteRecord source = candidate.note();
			// Documents (DocumentIndexer) are indexed from a search text, whose offsets are not the file's.
			if (source.path().equals(target.path()) || files.isExcluded(source.path())
					|| this.kinds.kindOf(source.path()) != FileKind.NOTE) {
				continue;
			}
			List<Mention> mentions = new ArrayList<>();
			for (MentionFinder.Found found : MentionFinder.find(source.text(), source.parse(), usable)) {
				mentions.add(mention(source, found.line(), found.from(), found.to(), found.matched()));
			}
			if (!mentions.isEmpty()) {
				groups.add(new BacklinkGroup(source.path(), source.version(), mentions));
				if (groups.size() == MAX_UNLINKED_GROUPS) {
					break;
				}
			}
		}
		return groups;
	}

	/** A mention with its line as context, clipped to 240 characters around it. */
	private static Mention mention(NoteRecord source, int line, int from, int to, String matched) {
		String text = source.text();
		int[] lineStarts = source.parse().lineStarts();
		int lineStart = lineStarts[line];
		int lineEnd = MarkdownScanner.contentEnd(text, lineStarts, line);
		int relativeTo = Math.min(to, lineEnd) - lineStart;
		SnippetBuilder.Clipped clipped = SnippetBuilder.clip(text.substring(lineStart, lineEnd),
				List.of(new TextRange(from - lineStart, relativeTo)), CONTEXT_WIDTH);
		TextRange range = clipped.ranges().isEmpty() ? new TextRange(0, 0) : clipped.ranges().get(0);
		return new Mention(line, from, to, matched, clipped.text(), range);
	}

	/**
	 * {@code POST /api/links/resolve}: each target resolved from {@code source}'s folder; unresolved targets get the
	 * path a note would be created at, when that is possible.
	 */
	public ResolveResponse resolve(String source, List<@Nullable String> targets) {
		if (targets.isEmpty() || targets.size() > MAX_RESOLVE_TARGETS) {
			throw NotesException.badRequest("targets must have 1 to " + MAX_RESOLVE_TARGETS + " entries");
		}
		String sourcePath = this.paths.normalize(source);
		FilesSettings files = this.settings.current().files();
		Map<String, ResolvedLink> resolved = new LinkedHashMap<>();
		for (String target : targets) {
			if (target == null) {
				throw NotesException.badRequest("targets must be strings");
			}
			if (resolved.containsKey(target)) {
				continue;
			}
			String path = this.index.resolveLink(target, sourcePath);
			String createPath = (path == null) ? LinkResolver.createPath(target, sourcePath, files.newNoteLocation(),
					files.newNoteFolder(), this.kinds::isKnownExtension) : null;
			resolved.put(target, new ResolvedLink(path, createPath));
		}
		return new ResolveResponse(resolved);
	}

}
