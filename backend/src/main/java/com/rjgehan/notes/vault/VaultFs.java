package com.rjgehan.notes.vault;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * Low-level vault I/O (DESIGN §5.4). Every write is staged in {@code .notesapp/tmp/<uuid>.tmp}, whose fixed-length
 * name never depends on the target's name. Replacing writes are atomic renames; writes that must not replace an
 * existing file use a hard link, which fails atomically when the target exists. Nothing here follows symlinks.
 */
@Component
public class VaultFs {

	private static final Logger logger = LoggerFactory.getLogger(VaultFs.class);

	private static final LinkOption[] NOFOLLOW = { LinkOption.NOFOLLOW_LINKS };

	private static final String SIBLING_TEMP_PREFIX = ".notesapp-";

	private final Path root;

	private final Path tmpDir;

	private final boolean syncDirectories;

	private final AtomicBoolean warnedNonAtomic = new AtomicBoolean();

	private final AtomicBoolean warnedNoLinks = new AtomicBoolean();

	public VaultFs(NotesProperties properties) {
		this.root = properties.vaultDir().toAbsolutePath().normalize();
		this.tmpDir = this.root.resolve(".notesapp").resolve("tmp");
		this.syncDirectories = !VaultPaths.isWindows();
	}

	public Path root() {
		return this.root;
	}

	public Path tmpDir() {
		return this.tmpDir;
	}

	/** The absolute path of a repo-relative on-disk path ({@code ""} is the vault root). */
	public Path resolve(String disk) {
		return disk.isEmpty() ? this.root : this.root.resolve(disk);
	}

	/** Creates {@code .notesapp/tmp} and removes anything a previous run left there. */
	public void prepareTmp() throws IOException {
		Files.createDirectories(this.tmpDir);
		try (var children = Files.list(this.tmpDir)) {
			for (Path child : children.toList()) {
				deleteRecursively(child);
			}
		}
	}

	public byte[] readBytes(String disk) throws IOException {
		try (InputStream in = openStream(disk)) {
			return in.readAllBytes();
		}
	}

	public InputStream openStream(String disk) throws IOException {
		SeekableByteChannel channel = Files.newByteChannel(resolve(disk),
				Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
		return Channels.newInputStream(channel);
	}

	/** The entry's attributes without following links, or null when it does not exist. */
	public @Nullable BasicFileAttributes attributes(String disk) {
		return attributes(resolve(disk));
	}

	public static @Nullable BasicFileAttributes attributes(Path path) {
		try {
			return Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);
		}
		catch (IOException ex) {
			return null;
		}
	}

	/** Replaces (or creates) a file atomically: temp file, fsync, atomic rename, fsync of the parent. */
	public void atomicWrite(String disk, byte[] bytes) throws IOException {
		Path target = resolve(disk);
		Path tmp = writeTemp(bytes);
		try {
			replace(tmp, target);
		}
		finally {
			Files.deleteIfExists(tmp);
		}
		syncDirectory(target.getParent());
	}

	/**
	 * Creates a file that must not exist. Throws {@link FileAlreadyExistsException} when it does, even if another
	 * process creates it concurrently.
	 */
	public void createExclusive(String disk, byte[] bytes) throws IOException {
		Path target = resolve(disk);
		Path tmp = writeTemp(bytes);
		try {
			placeExclusive(tmp, target);
		}
		finally {
			Files.deleteIfExists(tmp);
		}
		syncDirectory(target.getParent());
	}

	/** Streams a request body to a new temp file, aborting with {@code 413} once {@code limit} bytes are exceeded. */
	public Path writeTemp(InputStream in, long limit) throws IOException {
		Path tmp = newTempPath();
		try (FileChannel channel = FileChannel.open(tmp, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
				OutputStream out = Channels.newOutputStream(channel)) {
			byte[] buffer = new byte[64 * 1024];
			long total = 0;
			int read;
			while ((read = in.read(buffer)) != -1) {
				total += read;
				if (total > limit) {
					throw NotesException.tooLarge(limit, "The upload is larger than " + limit + " bytes");
				}
				out.write(buffer, 0, read);
			}
			out.flush();
			channel.force(true);
		}
		catch (IOException | RuntimeException ex) {
			Files.deleteIfExists(tmp);
			throw ex;
		}
		return tmp;
	}

	/**
	 * Places a staged temp file at a path that must not exist. On success the temp file is consumed; on
	 * {@link FileAlreadyExistsException} it is kept, so a rename-mode caller can try the next name with it.
	 */
	public void createExclusiveFrom(Path tmp, String disk) throws IOException {
		Path target = resolve(disk);
		placeExclusive(tmp, target);
		Files.deleteIfExists(tmp);
		syncDirectory(target.getParent());
	}

	/** Atomically replaces a file with a staged temp file; the temp file is consumed. */
	public void replaceFrom(Path tmp, String disk) throws IOException {
		Path target = resolve(disk);
		try {
			replace(tmp, target);
		}
		finally {
			Files.deleteIfExists(tmp);
		}
		syncDirectory(target.getParent());
	}

	/** Moves a file to a path that must not exist, never replacing anything. */
	public void moveExclusive(String fromDisk, String toDisk) throws IOException {
		Path source = resolve(fromDisk);
		Path target = resolve(toDisk);
		placeExclusive(source, target);
		Files.deleteIfExists(source);
		syncDirectory(source.getParent());
		syncDirectory(target.getParent());
	}

	/**
	 * Places a copy of a file at a path that must not exist, leaving the source in place: a hard link where the
	 * filesystem has them (instant, and safe because every app write replaces a file by renaming a new one over it),
	 * else a real copy.
	 */
	public void copyExclusive(String fromDisk, String toDisk) throws IOException {
		Path target = resolve(toDisk);
		placeExclusive(resolve(fromDisk), target);
		syncDirectory(target.getParent());
	}

	/**
	 * Moves a directory with an atomic rename. Directories cannot be hard-linked, so unlike {@link #moveExclusive} this
	 * relies on the caller's locks to keep internal racers away from the target name.
	 */
	public void moveDirectory(String fromDisk, String toDisk) throws IOException {
		Path source = resolve(fromDisk);
		Path target = resolve(toDisk);
		try {
			Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
		}
		catch (AtomicMoveNotSupportedException ex) {
			Files.move(source, target);
		}
		syncDirectory(source.getParent());
		syncDirectory(target.getParent());
	}

	/**
	 * A fresh repo-relative path beside {@code disk}, named {@code .notesapp-<uuid>.tmp}: a dot-name, so the index, the
	 * watcher and git ({@code .git/info/exclude}) ignore it. Used as the stepping stone of a case-only rename, which
	 * must not go through {@code .notesapp/tmp}: that folder is emptied at startup and may be on another filesystem.
	 */
	public static String siblingTempName(String disk) {
		return PathNames.join(PathNames.parentOf(disk), SIBLING_TEMP_PREFIX + UUID.randomUUID() + ".tmp");
	}

	/** True when an entry with exactly this name is listed in its parent directory (case and form must match). */
	public boolean existsExactly(String disk) {
		Path path = resolve(disk);
		Path parent = path.getParent();
		if (parent == null || attributes(path) == null) {
			return false;
		}
		String name = path.getFileName().toString();
		try (var children = Files.list(parent)) {
			return children.anyMatch((child) -> child.getFileName().toString().equals(name));
		}
		catch (IOException ex) {
			return false;
		}
	}

	/**
	 * Creates one directory. Returns true when it was created, false when a directory already exists; throws
	 * {@link FileAlreadyExistsException} when a non-directory is in the way.
	 */
	public boolean createDirectory(String disk) throws IOException {
		Path dir = resolve(disk);
		try {
			Files.createDirectory(dir);
			syncDirectory(dir.getParent());
			return true;
		}
		catch (FileAlreadyExistsException ex) {
			BasicFileAttributes attributes = attributes(dir);
			if (attributes != null && attributes.isDirectory() && !attributes.isSymbolicLink()) {
				return false;
			}
			throw ex;
		}
	}

	/**
	 * Moves an entry (a file, a folder or a symlink, which is never followed) into {@code .notesapp/tmp} under a fresh
	 * name, so that it can be deleted with {@link #deleteRecursively} after the caller has released its locks. Returns
	 * that path, or null when the entry is on another filesystem and was deleted in place instead. A crash before the
	 * delete leaves nothing visible: {@code .notesapp/tmp} is emptied at startup.
	 */
	public @Nullable Path stageForDeletion(Path entry) throws IOException {
		Files.createDirectories(this.tmpDir);
		Path staged = this.tmpDir.resolve("purge-" + UUID.randomUUID());
		try {
			Files.move(entry, staged, StandardCopyOption.ATOMIC_MOVE);
		}
		catch (AtomicMoveNotSupportedException ex) {
			deleteRecursively(entry);
			return null;
		}
		syncDirectory(entry.getParent());
		return staged;
	}

	/** Deletes a file or directory tree. Symlinks are deleted, never followed. */
	public void deleteRecursively(Path path) throws IOException {
		BasicFileAttributes attributes = attributes(path);
		if (attributes == null) {
			return;
		}
		if (!attributes.isDirectory()) {
			Files.deleteIfExists(path);
			return;
		}
		Files.walkFileTree(path, new SimpleFileVisitor<>() {

			@Override
			public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
				Files.deleteIfExists(file);
				return FileVisitResult.CONTINUE;
			}

			@Override
			public FileVisitResult visitFileFailed(Path file, IOException exc) throws IOException {
				if (exc instanceof NoSuchFileException) {
					return FileVisitResult.CONTINUE;
				}
				throw exc;
			}

			@Override
			public FileVisitResult postVisitDirectory(Path dir, @Nullable IOException exc) throws IOException {
				if (exc != null) {
					throw exc;
				}
				Files.deleteIfExists(dir);
				return FileVisitResult.CONTINUE;
			}

		});
	}

	public long usableSpace() throws IOException {
		return Files.getFileStore(this.root).getUsableSpace();
	}

	private Path newTempPath() throws IOException {
		Files.createDirectories(this.tmpDir);
		return this.tmpDir.resolve(UUID.randomUUID() + ".tmp");
	}

	private Path writeTemp(byte[] bytes) throws IOException {
		Path tmp = newTempPath();
		writeSynced(tmp, bytes);
		return tmp;
	}

	private static void writeSynced(Path path, byte[] bytes) throws IOException {
		try (FileChannel channel = FileChannel.open(path, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
			ByteBuffer buffer = ByteBuffer.wrap(bytes);
			while (buffer.hasRemaining()) {
				channel.write(buffer);
			}
			channel.force(true);
		}
		catch (IOException ex) {
			Files.deleteIfExists(path);
			throw ex;
		}
	}

	private void replace(Path source, Path target) throws IOException {
		try {
			Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
		}
		catch (AtomicMoveNotSupportedException ex) {
			// The target folder is a separate mount: stage a sibling dot-file (ignored by the watcher) instead.
			Path sibling = target.resolveSibling(SIBLING_TEMP_PREFIX + UUID.randomUUID() + ".tmp");
			try {
				Files.copy(source, sibling);
				try (FileChannel channel = FileChannel.open(sibling, StandardOpenOption.WRITE)) {
					channel.force(true);
				}
				try {
					Files.move(sibling, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
				}
				catch (AtomicMoveNotSupportedException again) {
					if (this.warnedNonAtomic.compareAndSet(false, true)) {
						logger.warn("The vault filesystem does not support atomic renames; writes are not atomic");
					}
					Files.move(sibling, target, StandardCopyOption.REPLACE_EXISTING);
				}
			}
			finally {
				Files.deleteIfExists(sibling);
			}
		}
	}

	private void placeExclusive(Path source, Path target) throws IOException {
		try {
			Files.createLink(target, source);
		}
		catch (FileAlreadyExistsException ex) {
			throw ex;
		}
		catch (UnsupportedOperationException | FileSystemException ex) {
			if (Files.exists(target, NOFOLLOW)) {
				throw new FileAlreadyExistsException(target.toString());
			}
			if (this.warnedNoLinks.compareAndSet(false, true)) {
				logger.warn("Hard links are not available ({}); exclusive creates fall back to check-then-move",
						ex.getMessage());
			}
			Path sibling = target.resolveSibling(SIBLING_TEMP_PREFIX + UUID.randomUUID() + ".tmp");
			try {
				Files.copy(source, sibling);
				try {
					Files.move(sibling, target, StandardCopyOption.ATOMIC_MOVE);
				}
				catch (AtomicMoveNotSupportedException again) {
					Files.move(sibling, target);
				}
			}
			finally {
				Files.deleteIfExists(sibling);
			}
		}
	}

	private void syncDirectory(@Nullable Path dir) {
		if (!this.syncDirectories || dir == null) {
			return;
		}
		try (FileChannel channel = FileChannel.open(dir, StandardOpenOption.READ)) {
			channel.force(true);
		}
		catch (IOException ex) {
			// Some filesystems do not support syncing directories.
		}
	}

}
