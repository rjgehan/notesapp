package com.rjgehan.notes.history;

import java.util.List;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;

/**
 * The large-file policy (DESIGN §5.8, ROADMAP item 23): files larger than {@code notes.git.large-file-threshold}
 * stay in the vault, and in backups, but out of git history, so the repository stays small (and under GitHub's file
 * limit, for the mirror). The set is always derived from the index; {@link GitStore} turns it into the managed
 * section of {@code info/exclude} before every commit and stops tracking such a file when a commit touches it.
 */
@Component
public class LargeFiles {

	/** A file kept out of history. */
	public record Entry(String path, String disk, long size) {
	}

	/** The files currently kept out of history, in path order, and their total size. */
	public record Snapshot(long limit, List<Entry> files, long bytes) {
	}

	private final VaultIndex index;

	private final long limit;

	public LargeFiles(VaultIndex index, NotesProperties properties) {
		this.index = index;
		this.limit = Math.max(0, properties.git().largeFileThreshold().toBytes());
	}

	/** False when the threshold is 0: every file is versioned. */
	public boolean enabled() {
		return this.limit > 0;
	}

	/** The threshold in bytes; a file is large when it is strictly larger. 0 when the policy is off. */
	public long limit() {
		return this.limit;
	}

	public Snapshot current() {
		if (!enabled()) {
			return new Snapshot(0, List.of(), 0);
		}
		List<Entry> files = this.index.filesLargerThan(this.limit)
			.stream()
			.map((file) -> new Entry(file.path(), file.disk(), file.size()))
			.toList();
		return new Snapshot(this.limit, files, files.stream().mapToLong(Entry::size).sum());
	}

	/** The indexed file at {@code path} when it is kept out of history, else null. */
	public @Nullable Entry entry(String path) {
		if (!enabled()) {
			return null;
		}
		FileRecord record = this.index.file(path);
		if (record == null || record.size() <= this.limit) {
			return null;
		}
		String disk = this.index.diskPath(path);
		return new Entry(path, (disk != null) ? disk : path, record.size());
	}

	/** The threshold for messages: {@code "25 MB"}. */
	public String describeLimit() {
		return describe(this.limit);
	}

	static String describe(long bytes) {
		long mib = 1024 * 1024;
		if (bytes >= mib && bytes % mib == 0) {
			return (bytes / mib) + " MB";
		}
		if (bytes >= 1024 && bytes % 1024 == 0) {
			return (bytes / 1024) + " KB";
		}
		return bytes + " bytes";
	}

	/**
	 * An {@code info/exclude} line that matches exactly one on-disk path: anchored at the root, with the glob
	 * characters and trailing spaces escaped, so names such as {@code Scan [1].pdf} never match anything else.
	 */
	static String pattern(String disk) {
		StringBuilder line = new StringBuilder(disk.length() + 8).append('/');
		int end = disk.length();
		while (end > 0 && disk.charAt(end - 1) == ' ') {
			end--;
		}
		for (int i = 0; i < end; i++) {
			char c = disk.charAt(i);
			if (c == '\\' || c == '*' || c == '?' || c == '[') {
				line.append('\\');
			}
			line.append(c);
		}
		line.append("\\ ".repeat(disk.length() - end));
		return line.toString();
	}

}
