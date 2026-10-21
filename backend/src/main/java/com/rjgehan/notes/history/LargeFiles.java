package com.rjgehan.notes.history;

import java.util.List;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

/**
 * The large-file policy (DESIGN §5.8, ROADMAP item 23): files larger than {@code notes.git.large-file-threshold}
 * stay in the vault, and in backups, but out of git history, so the repository stays small (and under GitHub's file
 * limit, for the mirror). The set listed here is derived from the index; {@link GitStore} adds the large files the
 * index never sees (hidden files, ignored names) from the disk, turns both into the managed section of
 * {@code info/exclude} before every commit, and stops tracking such a file when a commit touches it.
 * <p>
 * The threshold is 0 (off) or at least the largest text size limit: text saves keep no copy of the version they
 * replace, so every file the app can save as text must stay small enough to be versioned.
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
		this.limit = threshold(properties);
	}

	/**
	 * The configured threshold in bytes.
	 * @throws IllegalStateException when it is below the largest text size limit, which would leave notes between the
	 * two without versions while saves overwrite them
	 */
	static long threshold(NotesProperties properties) {
		long limit = Math.max(0, properties.git().largeFileThreshold().toBytes());
		NotesProperties.Limits limits = properties.limits();
		long text = limits.textSizeOverrides()
			.values()
			.stream()
			.mapToLong(DataSize::toBytes)
			.reduce(limits.maxTextSize().toBytes(), Math::max);
		if (limit > 0 && limit < text) {
			throw new IllegalStateException("notes.git.large-file-threshold (" + describe(limit)
					+ ") is below the largest text size limit (" + describe(text)
					+ ", notes.limits.max-text-size and notes.limits.text-size-overrides): notes up to that size "
					+ "would not be versioned, and saving them keeps no copy of the old version. Set it to 0 or to at "
					+ "least " + describe(text) + ".");
		}
		return limit;
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
