package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.VaultIndex;
import org.jspecify.annotations.Nullable;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Validates API paths and maps them to disk (DESIGN §5.3). {@link Mode#EXISTING} addresses entries that exist or
 * existed; {@link Mode#NEW} introduces a name and also applies the new-name rules to the final segment and to every
 * folder segment that will be created. Implicit parent folders of new paths resolve case-insensitively.
 */
@Component
public class VaultPaths {

	public enum Mode {

		/** An entry that exists or existed: exact-case lookup through the index. */
		EXISTING,

		/** A name the request introduces: new-name rules, implicit parents resolved case-insensitively. */
		NEW,

		/**
		 * A name that existed and is brought back (trash restore to the original path): implicit parents resolve
		 * case-insensitively like {@link #NEW}, but the new-name rules are not applied.
		 */
		RESTORE

	}

	public static final int MAX_PATH_CHARS = 1024;

	public static final int MAX_SEGMENT_BYTES = 255;

	private final VaultIndex index;

	private final VaultFs fs;

	private final boolean windowsRules;

	private volatile @Nullable Path realRoot;

	@Autowired
	public VaultPaths(VaultIndex index, VaultFs fs) {
		this(index, fs, isWindows());
	}

	public VaultPaths(VaultIndex index, VaultFs fs, boolean windowsRules) {
		this.index = index;
		this.fs = fs;
		this.windowsRules = windowsRules;
	}

	public static boolean isWindows() {
		return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows");
	}

	/**
	 * Applies the safety rules (and, on Windows, the Windows name rules) and returns the NFC form, without consulting
	 * the index or the disk. Used for paths that need not exist, such as history lookups.
	 */
	public String normalize(String apiPath) {
		String nfc = checkSyntax(apiPath);
		if (this.windowsRules) {
			for (String segment : nfc.split("/")) {
				String violation = NameRules.windowsViolation(segment);
				if (violation != null) {
					throw NotesException.invalidName(nfc, violation);
				}
			}
		}
		return nfc;
	}

	public ApiPath resolve(String apiPath, Mode mode) {
		String nfc = normalize(apiPath);
		ApiPath resolved = switch (mode) {
			case EXISTING -> mapExisting(nfc);
			case NEW -> mapNew(nfc, true);
			case RESTORE -> mapNew(nfc, false);
		};
		checkOnDisk(resolved, false);
		return resolved;
	}

	/**
	 * {@link Mode#EXISTING} for endpoints that read a file's bytes. Symlinks are ignored by the index and never served,
	 * so a final segment that is a symlink is reported as missing ({@code 404}, API.md §9.1); a symlink in a parent
	 * segment is still an invalid path.
	 */
	public ApiPath resolveForRead(String apiPath) {
		ApiPath resolved = mapExisting(normalize(apiPath));
		checkOnDisk(resolved, true);
		return resolved;
	}

	private String checkSyntax(@Nullable String apiPath) {
		if (apiPath == null || apiPath.isBlank()) {
			throw NotesException.invalidPath(apiPath == null ? "" : apiPath, "The path is empty");
		}
		if (apiPath.length() > MAX_PATH_CHARS) {
			throw NotesException.invalidPath(apiPath, "The path is longer than " + MAX_PATH_CHARS + " characters");
		}
		String nfc = Normalizer.normalize(apiPath, Normalizer.Form.NFC);
		Violation violation = safetyViolation(nfc);
		if (violation != null) {
			throw violation.reserved() ? NotesException.reservedPath(nfc)
					: NotesException.invalidPath(nfc, violation.message());
		}
		return nfc;
	}

	/** Why a path breaks the safety rules: {@code reserved} for a dot-segment (403), otherwise invalid (400). */
	public record Violation(boolean reserved, String message) {
	}

	/**
	 * The safety rules of DESIGN §4.4 on an NFC path, without consulting the index or the disk (used, for example, for
	 * folder paths in settings). Returns null when the path is safe.
	 */
	public static @Nullable Violation safetyViolation(String nfc) {
		if (nfc.isBlank()) {
			return new Violation(false, "The path is empty");
		}
		if (nfc.length() > MAX_PATH_CHARS) {
			return new Violation(false, "The path is longer than " + MAX_PATH_CHARS + " characters");
		}
		if (nfc.startsWith("/") || nfc.endsWith("/")) {
			return new Violation(false, "Paths cannot start or end with /");
		}
		for (int i = 0; i < nfc.length(); i++) {
			char c = nfc.charAt(i);
			if (c == '\\') {
				return new Violation(false, "Paths cannot contain \\");
			}
			if (c < 0x20 || c == 0x7f) {
				return new Violation(false, "Paths cannot contain control characters");
			}
		}
		String[] segments = nfc.split("/", -1);
		for (String segment : segments) {
			if (segment.isEmpty()) {
				return new Violation(false, "Paths cannot contain empty segments");
			}
			if (segment.equals(".") || segment.equals("..")) {
				return new Violation(false, "Paths cannot contain . or .. segments");
			}
			if (segment.getBytes(StandardCharsets.UTF_8).length > MAX_SEGMENT_BYTES) {
				return new Violation(false, "A name is longer than " + MAX_SEGMENT_BYTES + " bytes");
			}
		}
		for (String segment : segments) {
			if (segment.startsWith(".")) {
				return new Violation(true, "Hidden and internal paths cannot be used");
			}
		}
		return null;
	}

	private ApiPath mapExisting(String nfc) {
		String disk = this.index.diskPath(nfc);
		if (disk != null) {
			return new ApiPath(nfc, disk);
		}
		String folder = PathNames.parentOf(nfc);
		List<String> tail = new ArrayList<>();
		tail.add(PathNames.nameOf(nfc));
		while (!folder.isEmpty()) {
			String folderDisk = this.index.diskPath(folder);
			if (folderDisk != null) {
				return new ApiPath(nfc, folderDisk + "/" + String.join("/", tail.reversed()));
			}
			tail.add(PathNames.nameOf(folder));
			folder = PathNames.parentOf(folder);
		}
		return new ApiPath(nfc, nfc);
	}

	private ApiPath mapNew(String nfc, boolean newNameRules) {
		String[] segments = nfc.split("/");
		String realParent = "";
		String diskParent = "";
		int i = 0;
		for (; i < segments.length - 1; i++) {
			String candidate = PathNames.join(realParent, segments[i]);
			String existing = this.index.folderIgnoreCase(candidate);
			if (existing == null) {
				break;
			}
			realParent = existing;
			String disk = this.index.diskPath(existing);
			diskParent = disk != null ? disk : existing;
		}
		StringBuilder realPath = new StringBuilder(realParent);
		StringBuilder diskPath = new StringBuilder(diskParent);
		for (; i < segments.length; i++) {
			String violation = newNameRules ? NameRules.newNameViolation(segments[i]) : null;
			if (violation != null) {
				throw NotesException.invalidName(nfc, violation);
			}
			if (!realPath.isEmpty()) {
				realPath.append('/');
				diskPath.append('/');
			}
			realPath.append(segments[i]);
			diskPath.append(segments[i]);
		}
		return new ApiPath(realPath.toString(), diskPath.toString());
	}

	/**
	 * Rejects any symlink segment inside the vault, and any existing ancestor whose real path escapes the vault (for
	 * example through a Windows junction).
	 */
	private void checkOnDisk(ApiPath path, boolean finalLinkIsMissing) {
		Path current = this.fs.root();
		Path lastExisting = current;
		String[] segments = path.disk().split("/");
		for (int i = 0; i < segments.length; i++) {
			current = current.resolve(segments[i]);
			BasicFileAttributes attributes = attributesOrNull(current);
			if (attributes == null) {
				break;
			}
			if (attributes.isSymbolicLink() || attributes.isOther()) {
				if (finalLinkIsMissing && i == segments.length - 1) {
					throw NotesException.notFound(path.nfc());
				}
				throw NotesException.invalidPath(path.nfc(), "Symbolic links are not supported");
			}
			lastExisting = current;
			if (!attributes.isDirectory()) {
				break;
			}
		}
		try {
			if (!lastExisting.toRealPath().startsWith(realRoot())) {
				throw NotesException.invalidPath(path.nfc(), "The path escapes the vault");
			}
		}
		catch (IOException ex) {
			// The entry disappeared between the checks; the caller reports it as missing.
		}
	}

	private Path realRoot() throws IOException {
		Path root = this.realRoot;
		if (root == null) {
			root = this.fs.root().toRealPath();
			this.realRoot = root;
		}
		return root;
	}

	private static @Nullable BasicFileAttributes attributesOrNull(Path path) {
		try {
			return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
		}
		catch (IOException ex) {
			return null;
		}
	}

}
