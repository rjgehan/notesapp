package com.rjgehan.notes.vault;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VaultFsTest {

	@TempDir
	Path vault;

	private VaultFs fs;

	@BeforeEach
	void setUp() throws Exception {
		this.fs = new VaultFs(TestProperties.forVault(this.vault));
		this.fs.prepareTmp();
	}

	private List<Path> tempFiles() throws Exception {
		try (var stream = Files.list(this.fs.tmpDir())) {
			return stream.toList();
		}
	}

	@Test
	void createExclusiveRaceHasExactlyOneWinnerWithIntactBytes() throws Exception {
		for (int round = 0; round < 25; round++) {
			String name = "race-" + round + ".md";
			CountDownLatch start = new CountDownLatch(1);
			ExecutorService pool = Executors.newFixedThreadPool(2);
			List<Future<Boolean>> results = new ArrayList<>();
			for (String content : new String[] { "first writer\n", "second writer\n" }) {
				results.add(pool.submit(() -> {
					start.await();
					try {
						this.fs.createExclusive(name, content.getBytes(StandardCharsets.UTF_8));
						return true;
					}
					catch (FileAlreadyExistsException ex) {
						return false;
					}
				}));
			}
			start.countDown();
			int winners = 0;
			int winnerIndex = -1;
			for (int i = 0; i < results.size(); i++) {
				if (results.get(i).get()) {
					winners++;
					winnerIndex = i;
				}
			}
			pool.shutdown();
			assertThat(winners).isEqualTo(1);
			assertThat(Files.readString(this.vault.resolve(name)))
				.isEqualTo((winnerIndex == 0) ? "first writer\n" : "second writer\n");
		}
		assertThat(tempFiles()).isEmpty();
	}

	@Test
	void longNamesCanBeSavedRenamedAndDeleted() throws Exception {
		String name = "n".repeat(247) + ".md";
		this.fs.createExclusive(name, "one".getBytes(StandardCharsets.UTF_8));
		this.fs.atomicWrite(name, "two".getBytes(StandardCharsets.UTF_8));
		assertThat(Files.readString(this.vault.resolve(name))).isEqualTo("two");
		String renamed = "m".repeat(247) + ".md";
		this.fs.moveExclusive(name, renamed);
		assertThat(Files.exists(this.vault.resolve(name))).isFalse();
		assertThat(Files.readString(this.vault.resolve(renamed))).isEqualTo("two");
		this.fs.deleteRecursively(this.vault.resolve(renamed));
		assertThat(Files.exists(this.vault.resolve(renamed))).isFalse();
		assertThat(tempFiles()).isEmpty();
	}

	@Test
	void tempFilesAreRemovedAfterFailures() throws Exception {
		this.fs.createExclusive("taken.md", "x".getBytes(StandardCharsets.UTF_8));
		assertThatThrownBy(() -> this.fs.createExclusive("taken.md", "y".getBytes(StandardCharsets.UTF_8)))
			.isInstanceOf(FileAlreadyExistsException.class);
		assertThatThrownBy(() -> this.fs.writeTemp(new ByteArrayInputStream(new byte[100]), 10))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TOO_LARGE));
		assertThatThrownBy(() -> this.fs.atomicWrite("missing-folder/x.md", new byte[1]))
			.isInstanceOf(IOException.class);
		assertThat(tempFiles()).isEmpty();
		assertThat(Files.readString(this.vault.resolve("taken.md"))).isEqualTo("x");
	}

	@Test
	void moveExclusiveNeverReplacesAnExistingFile() throws Exception {
		this.fs.createExclusive("a.md", "a".getBytes(StandardCharsets.UTF_8));
		this.fs.createExclusive("b.md", "b".getBytes(StandardCharsets.UTF_8));
		assertThatThrownBy(() -> this.fs.moveExclusive("a.md", "b.md")).isInstanceOf(FileAlreadyExistsException.class);
		assertThat(Files.readString(this.vault.resolve("b.md"))).isEqualTo("b");
		assertThat(Files.readString(this.vault.resolve("a.md"))).isEqualTo("a");
	}

	@Test
	void uploadsStreamThroughTempFiles() throws Exception {
		Path tmp = this.fs.writeTemp(new ByteArrayInputStream("payload".getBytes(StandardCharsets.UTF_8)), 1024);
		this.fs.createExclusiveFrom(tmp, "upload.bin");
		assertThat(Files.readString(this.vault.resolve("upload.bin"))).isEqualTo("payload");
		Path replacement = this.fs.writeTemp(new ByteArrayInputStream("new".getBytes(StandardCharsets.UTF_8)), 1024);
		this.fs.replaceFrom(replacement, "upload.bin");
		assertThat(Files.readString(this.vault.resolve("upload.bin"))).isEqualTo("new");
		assertThat(tempFiles()).isEmpty();
	}

	@Test
	void createDirectoryReportsWhetherItCreatedTheFolder() throws Exception {
		assertThat(this.fs.createDirectory("Folder")).isTrue();
		assertThat(this.fs.createDirectory("Folder")).isFalse();
		this.fs.createExclusive("file.md", new byte[0]);
		assertThatThrownBy(() -> this.fs.createDirectory("file.md")).isInstanceOf(FileAlreadyExistsException.class);
	}

	@Test
	void prepareTmpEmptiesLeftovers() throws Exception {
		Files.writeString(this.fs.tmpDir().resolve("left.tmp"), "x");
		this.fs.prepareTmp();
		assertThat(tempFiles()).isEmpty();
	}

}
