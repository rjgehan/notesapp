package com.rjgehan.notes.publish;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * The published snapshots on disk (DESIGN §5.26): {@code <notes.publish.dir>/<slug>/index.html} and the snapshot's
 * attachments beside it, outside the vault. {@link #served} is the only thing the publish server consults: a slug and
 * an asset name are served only when they are listed there and match {@link #SLUG} and {@link #ASSET}, so nothing
 * else in the directory, and nothing outside it, can ever be reached through it.
 */
@Component
public class SnapshotStore {

	private static final Logger logger = LoggerFactory.getLogger(SnapshotStore.class);

	/** Lower-case letters, digits and inner hyphens, 1 to 80 characters. */
	public static final Pattern SLUG = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?");

	/** A content hash and a lower-case extension, as {@link #assetName} makes them. */
	public static final Pattern ASSET = Pattern.compile("[0-9a-f]{20}\\.[a-z0-9]{1,10}");

	static final String PAGE = "index.html";

	private static final String STAGING_PREFIX = ".staging-";

	private static final String OLD_PREFIX = ".old-";

	private final Path root;

	/** Slug to the asset names of its snapshot; replaced as a whole. */
	private volatile Map<String, Set<String>> served = Map.of();

	public SnapshotStore(NotesProperties properties) {
		this.root = properties.publish().dir().toAbsolutePath().normalize();
	}

	public Path root() {
		return this.root;
	}

	/** Replaces what the publish server may serve. */
	public void setServed(Map<String, Set<String>> served) {
		this.served = Map.copyOf(served);
	}

	public Map<String, Set<String>> served() {
		return this.served;
	}

	/** True when a snapshot of {@code slug} is on disk. */
	public boolean exists(String slug) {
		return SLUG.matcher(slug).matches() && Files.isRegularFile(this.root.resolve(slug).resolve(PAGE),
				LinkOption.NOFOLLOW_LINKS);
	}

	/** The page of a served slug, or null. */
	public @Nullable Path page(String slug) {
		if (!SLUG.matcher(slug).matches() || !this.served.containsKey(slug)) {
			return null;
		}
		return regularFile(this.root.resolve(slug).resolve(PAGE));
	}

	/** An attachment of a served slug's snapshot, or null. */
	public @Nullable Path asset(String slug, String name) {
		if (!SLUG.matcher(slug).matches() || !ASSET.matcher(name).matches()) {
			return null;
		}
		Set<String> assets = this.served.get(slug);
		if (assets == null || !assets.contains(name)) {
			return null;
		}
		return regularFile(this.root.resolve(slug).resolve(name));
	}

	private @Nullable Path regularFile(Path file) {
		Path normalized = file.normalize();
		if (!normalized.startsWith(this.root) || !Files.isRegularFile(normalized, LinkOption.NOFOLLOW_LINKS)) {
			return null;
		}
		return normalized;
	}

	/**
	 * Writes a snapshot: the page and its attachments go to a staging folder first, which then replaces the previous
	 * snapshot of the slug in one rename.
	 */
	public void write(String slug, String html, Map<String, Path> assets) throws IOException {
		requireSlug(slug);
		Files.createDirectories(this.root);
		Path staging = this.root.resolve(STAGING_PREFIX + UUID.randomUUID());
		Files.createDirectory(staging);
		try {
			Files.writeString(staging.resolve(PAGE), html, StandardCharsets.UTF_8);
			for (Map.Entry<String, Path> asset : assets.entrySet()) {
				if (!ASSET.matcher(asset.getKey()).matches()) {
					throw new IllegalArgumentException("Bad asset name " + asset.getKey());
				}
				Files.copy(asset.getValue(), staging.resolve(asset.getKey()), StandardCopyOption.REPLACE_EXISTING);
			}
			Path target = this.root.resolve(slug);
			Path old = null;
			if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
				old = this.root.resolve(OLD_PREFIX + UUID.randomUUID());
				move(target, old);
			}
			move(staging, target);
			if (old != null) {
				deleteRecursively(old);
			}
		}
		finally {
			if (Files.exists(staging, LinkOption.NOFOLLOW_LINKS)) {
				deleteRecursively(staging);
			}
		}
	}

	/** Removes the snapshot of {@code slug}, if any. */
	public void delete(String slug) throws IOException {
		requireSlug(slug);
		Path target = this.root.resolve(slug);
		if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
			Path old = this.root.resolve(OLD_PREFIX + UUID.randomUUID());
			move(target, old);
			deleteRecursively(old);
		}
	}

	/** Removes staging and replaced folders an interrupted write left behind. */
	public void cleanUp() {
		if (!Files.isDirectory(this.root)) {
			return;
		}
		try (DirectoryStream<Path> entries = Files.newDirectoryStream(this.root)) {
			for (Path entry : entries) {
				String name = entry.getFileName().toString();
				if (name.startsWith(STAGING_PREFIX) || name.startsWith(OLD_PREFIX)) {
					deleteRecursively(entry);
				}
			}
		}
		catch (IOException ex) {
			logger.warn("Could not clean up {}: {}", this.root, ex.toString());
		}
	}

	/** The asset name of an attachment: 20 hex digits of its SHA-256 and its lower-cased extension. */
	public static String assetName(Path file, String extension) throws IOException {
		MessageDigest digest;
		try {
			digest = MessageDigest.getInstance("SHA-256");
		}
		catch (NoSuchAlgorithmException ex) {
			throw new IllegalStateException(ex);
		}
		try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
			byte[] buffer = new byte[64 * 1024];
			for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) {
				digest.update(buffer, 0, n);
			}
		}
		return HexFormat.of().formatHex(digest.digest()).substring(0, 20) + "." + extension;
	}

	/** Streams a file to {@code out}. */
	static void copy(Path file, OutputStream out) throws IOException {
		Files.copy(file, out);
	}

	private static void requireSlug(String slug) {
		if (!SLUG.matcher(slug).matches()) {
			throw new IllegalArgumentException("Bad slug " + slug);
		}
	}

	private static void move(Path from, Path to) throws IOException {
		try {
			Files.move(from, to, StandardCopyOption.ATOMIC_MOVE);
		}
		catch (AtomicMoveNotSupportedException ex) {
			Files.move(from, to);
		}
	}

	private static void deleteRecursively(Path path) throws IOException {
		Files.walkFileTree(path, new SimpleFileVisitor<>() {
			@Override
			public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
				Files.delete(file);
				return FileVisitResult.CONTINUE;
			}

			@Override
			public FileVisitResult postVisitDirectory(Path dir, @Nullable IOException exc) throws IOException {
				Files.delete(dir);
				return FileVisitResult.CONTINUE;
			}
		});
	}

}
