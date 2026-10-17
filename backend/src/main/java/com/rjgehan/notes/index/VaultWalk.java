package com.rjgehan.notes.index;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.text.Normalizer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import com.rjgehan.notes.api.dto.SkipReason;
import com.rjgehan.notes.api.dto.SkippedEntry;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultFs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Walks a vault folder without following links (DESIGN §4.4, §4.5). Hidden and ignored entries are left out; names
 * with {@code \} or control characters are skipped as {@code unsafe-name}; when two on-disk names normalize to the
 * same NFC path, the first in byte order is kept and the other is skipped as {@code nfc-shadowed}.
 */
public final class VaultWalk {

	private static final Logger logger = LoggerFactory.getLogger(VaultWalk.class);

	private VaultWalk() {
	}

	public record FoundFolder(String path, String disk) {
	}

	public record FoundFile(String path, String disk, long size, Instant mtime) {
	}

	public record Result(List<FoundFolder> folders, List<FoundFile> files, List<SkippedEntry> skipped) {
	}

	/** Walks the folder at {@code (path, disk)}, excluding the folder itself. {@code ""} is the vault root. */
	public static Result walk(VaultFs fs, String path, String disk) throws IOException {
		Result result = new Result(new ArrayList<>(), new ArrayList<>(), new ArrayList<>());
		walk(fs.resolve(disk), path, disk, result);
		return result;
	}

	private static void walk(Path dir, String path, String disk, Result result) throws IOException {
		List<Path> children = new ArrayList<>();
		try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
			stream.forEach(children::add);
		}
		children.sort((a, b) -> Arrays.compareUnsigned(bytes(a), bytes(b)));
		Set<String> seen = new HashSet<>();
		for (Path child : children) {
			String name = child.getFileName().toString();
			BasicFileAttributes attributes = VaultFs.attributes(child);
			if (attributes == null || attributes.isSymbolicLink() || attributes.isOther()) {
				continue;
			}
			boolean directory = attributes.isDirectory();
			if (name.startsWith(".") || (!directory && NameRules.isIgnored(name))) {
				continue;
			}
			String childDisk = PathNames.join(disk, name);
			if (isUnsafe(name)) {
				logger.warn("Skipping {} because its name contains \\ or a control character", childDisk);
				result.skipped().add(new SkippedEntry(childDisk, SkipReason.UNSAFE_NAME));
				continue;
			}
			String childPath = PathNames.join(path, Normalizer.normalize(name, Normalizer.Form.NFC));
			if (!seen.add(childPath)) {
				logger.warn("Skipping {} because another name normalizes to {}", childDisk, childPath);
				result.skipped().add(new SkippedEntry(childDisk, SkipReason.NFC_SHADOWED));
				continue;
			}
			if (directory) {
				result.folders().add(new FoundFolder(childPath, childDisk));
				try {
					walk(child, childPath, childDisk, result);
				}
				catch (IOException ex) {
					logger.warn("Cannot list {}: {}", childDisk, ex.toString());
				}
			}
			else if (attributes.isRegularFile()) {
				result.files()
					.add(new FoundFile(childPath, childDisk, attributes.size(),
							attributes.lastModifiedTime().toInstant()));
			}
		}
	}

	static boolean isUnsafe(String name) {
		for (int i = 0; i < name.length(); i++) {
			char c = name.charAt(i);
			if (c == '\\' || c < 0x20 || c == 0x7f) {
				return true;
			}
		}
		return false;
	}

	private static byte[] bytes(Path path) {
		return path.getFileName().toString().getBytes(StandardCharsets.UTF_8);
	}

}
