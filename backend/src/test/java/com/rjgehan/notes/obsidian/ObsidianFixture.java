package com.rjgehan.notes.obsidian;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.stream.Stream;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.IndexedFile;
import com.rjgehan.notes.index.MarkdownScanner;
import com.rjgehan.notes.index.NoteParse;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.Hashing;
import tools.jackson.databind.json.JsonMapper;

/** The Obsidian fixture vault of {@code src/test/resources/vaults/obsidian} (ROADMAP item 24). */
final class ObsidianFixture {

	static final Path VAULT = Path.of("src/test/resources/vaults/obsidian").toAbsolutePath();

	static final FileKinds KINDS = new FileKinds(TestProperties.forVault(VAULT));

	static final JsonMapper JSON = JsonMapper.builder().build();

	private ObsidianFixture() {
	}

	/** Copies the fixture (with its .obsidian folder) into {@code target}. */
	static void copyTo(Path target) throws IOException {
		try (Stream<Path> walk = Files.walk(VAULT)) {
			for (Path source : walk.toList()) {
				Path destination = target.resolve(VAULT.relativize(source).toString());
				if (Files.isDirectory(source)) {
					Files.createDirectories(destination);
				}
				else {
					Files.copy(source, destination);
				}
			}
		}
	}

	/** The fixture's visible files indexed, as the server would. */
	static VaultIndex index() {
		VaultIndex index = new VaultIndex();
		try (Stream<Path> walk = Files.walk(VAULT)) {
			List<Path> files = walk.filter(Files::isRegularFile)
				.filter((p) -> !VAULT.relativize(p).toString().replace(java.io.File.separatorChar, '/').startsWith("."))
				.sorted()
				.toList();
			for (Path file : files) {
				String path = VAULT.relativize(file).toString().replace(java.io.File.separatorChar, '/');
				byte[] bytes = Files.readAllBytes(file);
				FileKind kind = KINDS.kindOf(path);
				if (kind == FileKind.NOTE) {
					String text = new String(bytes, StandardCharsets.UTF_8);
					NoteParse parse = MarkdownScanner.scan(text, false, false);
					index.put(new IndexedFile(new FileRecord(path, kind, bytes.length, Instant.EPOCH,
							Hashing.blobId(bytes), parse.aliases()), path, text, parse));
				}
				else {
					index.put(new IndexedFile(new FileRecord(path, kind, bytes.length, Instant.EPOCH, null, List.of()),
							path, null, null));
				}
			}
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
		return index;
	}

	/** A parsed note, ready for {@link VaultIndex#put}. */
	static IndexedFile note(String path, String text) {
		byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		return new IndexedFile(new FileRecord(path, FileKind.NOTE, bytes.length, Instant.EPOCH, Hashing.blobId(bytes),
				parse.aliases()), path, text, parse);
	}

	static ObsidianConfig config() {
		return new ObsidianConfigReader(null, JSON).read(VAULT);
	}

}
