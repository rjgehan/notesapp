package com.rjgehan.notes.vault;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

class HashingTest {

	@Test
	void emptyBlobMatchesGit() {
		assertThat(Hashing.blobId(new byte[0])).isEqualTo("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	}

	@Test
	void helloBlobMatchesGit() {
		assertThat(Hashing.blobId("hello\n".getBytes(StandardCharsets.UTF_8)))
			.isEqualTo("ce013625030ba8dba906f756967f9e9ca394464a");
	}

	@Test
	void streamingHashEqualsInMemoryHash(@TempDir Path dir) throws Exception {
		Path file = dir.resolve("x.bin");
		Files.write(file, "hello\n".getBytes(StandardCharsets.UTF_8));
		assertThat(Hashing.blobId(file)).isEqualTo("ce013625030ba8dba906f756967f9e9ca394464a");
	}

}
