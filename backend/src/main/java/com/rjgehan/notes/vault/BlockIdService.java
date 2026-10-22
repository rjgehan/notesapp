package com.rjgehan.notes.vault;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.BlockIdResult;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Service;

/**
 * Gives a block of a note an Obsidian block id (ROADMAP item 20, DESIGN §5.37, API.md §37). The client finds the block
 * (its scanner, {@code features/blocks.ts}, decides where an id belongs) and names the line it read; the server
 * splices the id into the note's current text under the file's lock, so a concurrent edit elsewhere in the note is
 * never lost: when lines moved, the line is found again by its text, and a block that already has an id keeps it.
 */
@Service
public class BlockIdService {

	/** A block id closing a line (DESIGN §5.5.4). */
	static final Pattern LINE_ID = Pattern.compile("(?:^|\\s)\\^([A-Za-z0-9-]+)\\s*$");

	private static final Pattern STANDALONE_ID = Pattern.compile("^\\s*\\^([A-Za-z0-9-]+)\\s*$");

	private static final Pattern VALID_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

	private static final String ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

	private static final int MAX_LINE_TEXT = 100_000;

	private final FileService files;

	private final FileKinds kinds;

	private final VaultPaths paths;

	private final SecureRandom random = new SecureRandom();

	public BlockIdService(FileService files, FileKinds kinds, VaultPaths paths) {
		this.files = files;
		this.kinds = kinds;
		this.paths = paths;
	}

	/** Where the id goes: at the end of the line, or on a line of its own after it. */
	public enum Placement {

		END, AFTER;

		static Placement parse(@Nullable String value) {
			if ("end".equals(value)) {
				return END;
			}
			if ("after".equals(value)) {
				return AFTER;
			}
			throw invalid("placement", "must be \"end\" or \"after\"");
		}

	}

	/** The outcome of {@link #plan}: the id, the line that holds it, and the new text (null when unchanged). */
	record Plan(String id, int line, @Nullable String text) {
	}

	public BlockIdResult addBlockId(@Nullable String path, @Nullable Integer line, @Nullable String lineText,
			@Nullable String placement, @Nullable String wanted, Identity identity, @Nullable String origin)
			throws IOException {
		if (path == null || path.isBlank()) {
			throw invalid("path", "required");
		}
		if (line == null || line < 0) {
			throw invalid("line", "must be a line number from 0");
		}
		if (lineText == null || lineText.indexOf('\n') >= 0 || lineText.length() > MAX_LINE_TEXT) {
			throw invalid("lineText", "must be one line of text");
		}
		Placement where = Placement.parse(placement);
		if (wanted != null && !VALID_ID.matcher(wanted).matches()) {
			throw invalid("id", "letters, digits and '-' only, at most 64");
		}
		String nfc = this.paths.resolve(path, VaultPaths.Mode.EXISTING).nfc();
		if (this.kinds.kindOf(nfc) != FileKind.NOTE) {
			throw NotesException.typeMismatch(nfc, "note", "Block ids belong in notes: " + nfc);
		}
		FileService.Edited<Plan> edited = this.files.editText(nfc, (text) -> {
			Plan plan = plan(text, line, lineText, where, wanted);
			return new FileService.Edit<>(plan.text(), plan);
		}, identity, origin);
		Plan plan = edited.value();
		return new BlockIdResult(plan.id(), plan.text() != null, plan.line(), edited.file());
	}

	/**
	 * Plans the edit on {@code text} (the same rules as the client's {@code planBlockId}): line {@code line} when it
	 * still reads {@code lineText}, else the only line that does; else {@code 409 block-not-found}.
	 */
	Plan plan(String text, int line, String lineText, Placement placement, @Nullable String wanted) {
		String[] raw = text.split("\n", -1);
		String[] lines = new String[raw.length];
		for (int i = 0; i < raw.length; i++) {
			lines[i] = raw[i].endsWith("\r") ? raw[i].substring(0, raw[i].length() - 1) : raw[i];
		}
		int at = line;
		if (at >= lines.length || !lines[at].equals(lineText)) {
			at = -1;
			if (!lineText.isBlank()) {
				for (int i = 0; i < lines.length; i++) {
					if (lines[i].equals(lineText)) {
						if (at >= 0) {
							at = -1;
							break;
						}
						at = i;
					}
				}
			}
			if (at < 0) {
				throw new NotesException(ErrorCode.BLOCK_NOT_FOUND,
						"The block changed since it was read; read the note again", Map.of("line", line));
			}
		}
		int offset = 0;
		for (int i = 0; i < at; i++) {
			offset += raw[i].length() + 1;
		}
		boolean crlf = text.contains("\r\n") && !Pattern.compile("(^|[^\\r])\\n").matcher(text).find();
		String eol = crlf ? "\r\n" : "\n";
		if (placement == Placement.END) {
			Matcher existing = LINE_ID.matcher(lines[at]);
			if (existing.find()) {
				return new Plan(existing.group(1), at, null);
			}
			String id = freeId(lines, wanted);
			String content = stripTrailing(lines[at]);
			int from = offset + content.length();
			String insert = (content.isEmpty() ? "" : " ") + "^" + id;
			return new Plan(id, at, text.substring(0, from) + insert + text.substring(offset + lines[at].length()));
		}
		for (int k = at + 1; k < lines.length && k <= at + 2; k++) {
			Matcher m = STANDALONE_ID.matcher(lines[k]);
			if (m.find()) {
				return new Plan(m.group(1), k, null);
			}
			if (!lines[k].isBlank()) {
				break;
			}
		}
		String id = freeId(lines, wanted);
		int end = offset + lines[at].length();
		boolean nextBlank = at + 1 >= lines.length || lines[at + 1].isBlank();
		String insert = eol + eol + "^" + id + (nextBlank ? "" : eol);
		return new Plan(id, at + 2, text.substring(0, end) + insert + text.substring(end));
	}

	/** {@code wanted} when no line of the note ends with it yet, else a new random id. */
	private String freeId(String[] lines, @Nullable String wanted) {
		Set<String> taken = new HashSet<>();
		for (String l : lines) {
			Matcher m = LINE_ID.matcher(l);
			if (m.find()) {
				taken.add(m.group(1).toLowerCase(Locale.ROOT));
			}
		}
		if (wanted != null && !taken.contains(wanted.toLowerCase(Locale.ROOT))) {
			return wanted;
		}
		while (true) {
			StringBuilder id = new StringBuilder(6);
			for (int i = 0; i < 6; i++) {
				id.append(ID_CHARS.charAt(this.random.nextInt(ID_CHARS.length())));
			}
			String s = id.toString();
			if (!taken.contains(s) && s.chars().anyMatch(Character::isLetter)) {
				return s;
			}
		}
	}

	private static String stripTrailing(String s) {
		int end = s.length();
		while (end > 0 && (s.charAt(end - 1) == ' ' || s.charAt(end - 1) == '\t')) {
			end--;
		}
		return s.substring(0, end);
	}

	private static NotesException invalid(String field, String message) {
		return new NotesException(ErrorCode.BAD_REQUEST, field + ": " + message,
				Map.of("errors", List.of(new FieldError(field, message))));
	}

}
