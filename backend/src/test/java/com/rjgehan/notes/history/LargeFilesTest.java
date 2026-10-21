package com.rjgehan.notes.history;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.support.TestProperties;
import org.eclipse.jgit.ignore.IgnoreNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalStateException;

class LargeFilesTest {

	private static IgnoreNode exclude(String... disks) throws IOException {
		StringBuilder text = new StringBuilder();
		for (String disk : disks) {
			text.append(LargeFiles.pattern(disk)).append('\n');
		}
		IgnoreNode node = new IgnoreNode();
		node.parse(new ByteArrayInputStream(text.toString().getBytes(StandardCharsets.UTF_8)));
		return node;
	}

	@Test
	void patternsAreAnchoredAndEscapeGlobCharacters() {
		assertThat(LargeFiles.pattern("Attachments/Holiday.mp4")).isEqualTo("/Attachments/Holiday.mp4");
		assertThat(LargeFiles.pattern("Scan [1].pdf")).isEqualTo("/Scan \\[1].pdf");
		assertThat(LargeFiles.pattern("a*b?.bin")).isEqualTo("/a\\*b\\?.bin");
		assertThat(LargeFiles.pattern("odd\\name.bin")).isEqualTo("/odd\\\\name.bin");
		assertThat(LargeFiles.pattern("trailing  ")).isEqualTo("/trailing\\ \\ ");
		// A leading # or ! is not special once the pattern starts with the anchoring slash.
		assertThat(LargeFiles.pattern("#notes.bin")).isEqualTo("/#notes.bin");
	}

	@Test
	void eachPatternMatchesExactlyItsOwnPathInGit() throws IOException {
		List<String> large = List.of("Attachments/Scan [1].pdf", "a*b?.bin", "dir/trailing ", "#hash.bin", "!bang.bin",
				"d/**/x.bin", "Ünïcödé/vidéo.mp4", "x{y}.bin", "odd\\name.bin");
		IgnoreNode node = exclude(large.toArray(String[]::new));
		for (String path : large) {
			assertThat(node.isIgnored(path, false)).as(path).isEqualTo(IgnoreNode.MatchResult.IGNORED);
		}
		List<String> others = List.of("Attachments/Scan 1.pdf", "Attachments/Scan [1]xpdf", "aXbY.bin", "dir/trailing",
				"hash.bin", "bang.bin", "d/a/x.bin", "d/x.bin", "sub/a*b?.bin", "Attachments/Scan [1].pdf.txt");
		for (String path : others) {
			assertThat(node.isIgnored(path, false)).as(path).isNotEqualTo(IgnoreNode.MatchResult.IGNORED);
		}
	}

	@Test
	void limitsAreDescribedInTheUnitsTheyWereGivenIn() {
		assertThat(LargeFiles.describe(25L * 1024 * 1024)).isEqualTo("25 MB");
		assertThat(LargeFiles.describe(1024)).isEqualTo("1 KB");
		assertThat(LargeFiles.describe(1500)).isEqualTo("1500 bytes");
	}

	private static long threshold(Map<String, String> overrides) {
		return LargeFiles.threshold(TestProperties.forVault(Path.of("vault"), overrides));
	}

	@Test
	void theThresholdIsOffOrAtLeastTheLargestTextLimit() {
		assertThat(threshold(Map.of())).isEqualTo(25L * 1024 * 1024);
		assertThat(threshold(Map.of("notes.git.large-file-threshold", "0"))).isZero();
		assertThat(threshold(Map.of("notes.git.large-file-threshold", "5MB"))).isEqualTo(5L * 1024 * 1024);
		assertThat(threshold(Map.of("notes.git.large-file-threshold", "1KB", "notes.limits.max-text-size", "1KB")))
			.isEqualTo(1024);
	}

	@Test
	void aThresholdBelowATextLimitIsRefused() {
		// Notes between the two would be unversioned, and a save keeps no copy of the version it replaces.
		assertThatIllegalStateException().isThrownBy(() -> threshold(Map.of("notes.git.large-file-threshold", "1MB")))
			.withMessageContaining("notes.git.large-file-threshold (1 MB) is below the largest text size limit (5 MB")
			.withMessageContaining("Set it to 0 or to at least 5 MB");
		assertThatIllegalStateException()
			.isThrownBy(() -> threshold(Map.of("notes.git.large-file-threshold", "10MB",
					"notes.limits.text-size-overrides.csv", "20MB")))
			.withMessageContaining("(20 MB,");
	}

}
