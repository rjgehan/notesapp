package com.rjgehan.notes.index;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.support.TestPdfs;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.vault.VaultFs;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

/** PDF text extraction (PDFBox) with its limits, and the background indexer with its cache. */
class PdfTextTest {

	@TempDir
	Path vault;

	private PdfTextIndexer indexer;

	@AfterEach
	void stop() {
		if (this.indexer != null) {
			this.indexer.stop();
		}
	}

	private Path write(String name, byte[] bytes) throws IOException {
		Path file = this.vault.resolve(name);
		Files.createDirectories(file.getParent());
		Files.write(file, bytes);
		return file;
	}

	private static long later() {
		return System.nanoTime() + Duration.ofSeconds(30).toNanos();
	}

	@Test
	void extractsPagesSeparatedByAFormFeedLine() throws IOException {
		Path file = write("a.pdf", TestPdfs.withPages("First page\nsecond line", "Page two"));
		PdfText.Result result = PdfText.extract(file, 100, 100_000, later());
		assertThat(result.pages()).isEqualTo(2);
		assertThat(result.truncated()).isFalse();
		assertThat(result.text()).isEqualTo("First page\nsecond line" + PdfText.PAGE_BREAK + "Page two");
	}

	@Test
	void limitsCutTheTextShort() throws IOException {
		Path file = write("a.pdf", TestPdfs.withPages("one", "two", "three"));
		PdfText.Result pages = PdfText.extract(file, 2, 100_000, later());
		assertThat(pages.text()).isEqualTo("one" + PdfText.PAGE_BREAK + "two");
		assertThat(pages.truncated()).isTrue();
		PdfText.Result chars = PdfText.extract(file, 100, 5, later());
		assertThat(chars.text()).hasSize(5);
		assertThat(chars.truncated()).isTrue();
		PdfText.Result late = PdfText.extract(file, 100, 100_000, System.nanoTime() - 1);
		assertThat(late.text()).isEmpty();
		assertThat(late.truncated()).isTrue();
	}

	@Test
	void aDamagedFileIsAnError() throws IOException {
		Path file = write("bad.pdf", "not a pdf".getBytes(StandardCharsets.UTF_8));
		assertThatThrownBy(() -> PdfText.extract(file, 100, 100_000, later())).isInstanceOf(IOException.class);
	}

	@Test
	void controlCharactersAreDropped() {
		assertThat(PdfText.clean("a\r\nb\rc\u0000d\fe  \n\n")).isEqualTo("a\nb\ncde");
	}

	// ---------------------------------------------------------------- the background indexer

	private VaultIndex index;

	private PdfTextIndexer start(Map<String, String> overrides) {
		NotesProperties properties = TestProperties.forVault(this.vault, overrides);
		this.index = new VaultIndex();
		this.indexer = new PdfTextIndexer(this.index, new VaultFs(properties), properties);
		return this.indexer;
	}

	private FileRecord record(String path) throws IOException {
		Path file = this.vault.resolve(path);
		return new FileRecord(path, FileKind.PDF, Files.size(file), Files.getLastModifiedTime(file).toInstant(), null,
				List.of());
	}

	private void put(String path) throws IOException {
		this.index.put(new IndexedFile(record(path), path, null, null));
	}

	private List<String> search(String query) {
		return this.index.search(SearchQueryParser.parse(query), false, (p) -> false, false)
			.hits()
			.stream()
			.map((hit) -> hit.note().path())
			.toList();
	}

	private List<String> cacheFiles() throws IOException {
		Path dir = this.vault.resolve(PdfTextIndexer.CACHE_DIR);
		if (!Files.isDirectory(dir)) {
			return List.of();
		}
		try (Stream<Path> files = Files.list(dir)) {
			return files.map((p) -> p.getFileName().toString()).toList();
		}
	}

	private void awaitIdle() {
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.indexer.isBusy());
	}

	@Test
	void indexesPdfsInTheBackgroundAndCachesTheirText() throws IOException {
		write("Docs/Manual.pdf", TestPdfs.withPages("Install the printer", "Paper jam"));
		start(Map.of());
		put("Docs/Manual.pdf");
		this.indexer.start();
		awaitIdle();
		assertThat(search("paper jam")).containsExactly("Docs/Manual.pdf");
		assertThat(cacheFiles()).hasSize(1);
		this.indexer.stop();

		// Same size and mtime, unreadable content: a restart serves the cached text instead of extracting again.
		Path file = this.vault.resolve("Docs/Manual.pdf");
		FileTime mtime = Files.getLastModifiedTime(file);
		byte[] garbage = new byte[(int) Files.size(file)];
		Files.write(file, garbage);
		Files.setLastModifiedTime(file, mtime);
		start(Map.of());
		put("Docs/Manual.pdf");
		this.indexer.start();
		awaitIdle();
		assertThat(search("paper jam")).containsExactly("Docs/Manual.pdf");
	}

	@Test
	void changedMovedAndDeletedPdfsKeepTheCacheInStep() throws IOException {
		write("a.pdf", TestPdfs.withPages("alpha text"));
		write("b.pdf", TestPdfs.withPages("bravo text"));
		start(Map.of());
		put("a.pdf");
		put("b.pdf");
		this.indexer.start();
		awaitIdle();
		assertThat(search("text")).containsExactlyInAnyOrder("a.pdf", "b.pdf");

		Files.move(this.vault.resolve("a.pdf"), this.vault.resolve("moved.pdf"));
		this.index.move("a.pdf", "moved.pdf", "moved.pdf");
		write("b.pdf", TestPdfs.withPages("charlie words"));
		Files.setLastModifiedTime(this.vault.resolve("b.pdf"), FileTime.from(Instant.parse("2030-01-01T00:00:00Z")));
		put("b.pdf");
		awaitIdle();
		assertThat(search("alpha")).containsExactly("moved.pdf");
		assertThat(search("bravo")).isEmpty();
		assertThat(search("charlie")).containsExactly("b.pdf");
		this.indexer.stop();

		// After a restart the moved file's cache entry is found under its new name, and stale entries are removed.
		Files.write(this.vault.resolve(PdfTextIndexer.CACHE_DIR).resolve("stale-1-2.txt"), new byte[0]);
		start(Map.of());
		put("moved.pdf");
		put("b.pdf");
		this.indexer.start();
		awaitIdle();
		await().atMost(Duration.ofSeconds(10))
			.until(() -> cacheFiles().size() == 2);
		assertThat(cacheFiles())
			.containsExactlyInAnyOrder(PdfTextIndexer.cacheName(record("moved.pdf")),
					PdfTextIndexer.cacheName(record("b.pdf")));
	}

	@Test
	void unreadableAndOversizedPdfsAreFoundByName() throws IOException {
		write("Broken scan.pdf", "not a pdf".getBytes(StandardCharsets.UTF_8));
		write("Huge report.pdf", TestPdfs.withPages("secret content"));
		start(Map.of("notes.search.pdf.max-size", "10B"));
		put("Broken scan.pdf");
		put("Huge report.pdf");
		this.indexer.start();
		awaitIdle();
		assertThat(search("broken")).containsExactly("Broken scan.pdf");
		assertThat(search("huge")).containsExactly("Huge report.pdf");
		assertThat(search("secret")).isEmpty();
	}

	@Test
	void extractionCanBeSwitchedOff() throws IOException {
		write("a.pdf", TestPdfs.withPages("alpha"));
		start(Map.of("notes.search.pdf.enabled", "false"));
		put("a.pdf");
		this.indexer.start();
		assertThat(this.indexer.isRunning()).isFalse();
		assertThat(search("alpha")).isEmpty();
	}

}
