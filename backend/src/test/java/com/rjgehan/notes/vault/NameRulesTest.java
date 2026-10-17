package com.rjgehan.notes.vault;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

class NameRulesTest {

	private final NameRules rules = new NameRules(new FileKinds(TestProperties.forVault(Path.of("vault"))));

	@ParameterizedTest
	@ValueSource(strings = { "Plan #2.md", "a^b.md", "[x].md", "x].md", "a|b.md", "50%% done.md", "x.tmp", "clip.part",
			"a~", "Thumbs.db", "4913", "file.swp", "file.swx", "dl.crdownload", "Meeting 10:30.md", "What?.md",
			"con.md", "LPT1.txt", "a:b", "trailing.", "trailing ", " leading.md", "q\"uote.md", "a<b.md", "a>b.md",
			"star*.md" })
	void rejectsNamesThatBreakTheNewNameRules(String name) {
		assertThat(NameRules.newNameViolation(name)).isNotNull();
	}

	@ParameterizedTest
	@ValueSource(strings = { "Plan.md", "Plan B.md", "50% done.md", "v1.2 notes.md", "Café.md", "a-b_c.md",
			"Untitled 1.md", "console.md", "com10.md", "notes" })
	void acceptsPortableNames(String name) {
		assertThat(NameRules.newNameViolation(name)).isNull();
	}

	@Test
	void newSegmentsAreCappedAt240Bytes() {
		assertThat(NameRules.newNameViolation("a".repeat(237) + ".md")).isNull();
		assertThat(NameRules.newNameViolation("a".repeat(238) + ".md")).isNotNull();
	}

	@Test
	void suffixesAreInsertedBeforeTheExtension() {
		assertThat(NameRules.withSuffix("a.png", 1)).isEqualTo("a 1.png");
		assertThat(NameRules.withSuffix("a.png", 2)).isEqualTo("a 2.png");
		assertThat(NameRules.withSuffix("Untitled.md", 1)).isEqualTo("Untitled 1.md");
		assertThat(NameRules.withSuffix("archive.tar.gz", 1)).isEqualTo("archive.tar 1.gz");
		assertThat(NameRules.withSuffix("notes", 3)).isEqualTo("notes 3");
	}

	@ParameterizedTest
	@CsvSource(delimiter = '|', value = { "a/b.png|b.png", "../x.png|x.png", ".env|env", "con.png|_con.png",
			"x.tmp|x.tmp.file", "notes .|notes", "a:b?.png|a-b-.png", ".png|attachment.png",
			"Pasted image 20261016140322.png|Pasted image 20261016140322.png", "a\\b\\c.jpg|c.jpg",
			"x%%y.png|x-y.png", "tab\there.png|tab-here.png", "a   b.png|a b.png", "Thumbs.db|Thumbs.db.file" })
	void sanitizesAttachmentNames(String raw, String expected) {
		assertThat(this.rules.sanitizeAttachmentName(raw)).isEqualTo(expected);
	}

	@Test
	void sanitizerTruncatesLongNamesOnCodePointBoundaries() {
		String sanitized = this.rules.sanitizeAttachmentName("a".repeat(296) + ".png");
		assertThat(sanitized.getBytes(StandardCharsets.UTF_8)).hasSize(240);
		assertThat(sanitized).endsWith(".png");

		String emoji = this.rules.sanitizeAttachmentName("😀".repeat(80) + ".png");
		assertThat(emoji.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(240);
		assertThat(emoji).endsWith(".png");
		assertThat(emoji.codePoints().filter((cp) -> cp == 0xFFFD)).isEmpty();
		assertThat(Character.isHighSurrogate(emoji.charAt(emoji.length() - 5))).isFalse();
	}

	@Test
	void sanitizedNamesAreValidNewNames() {
		for (String raw : new String[] { "a/b.png", ".env", "con.png", "x.tmp", "notes .", "a:b?.png", ".png",
				"a".repeat(300) }) {
			assertThat(NameRules.newNameViolation(this.rules.sanitizeAttachmentName(raw))).as(raw).isNull();
		}
	}

	@Test
	void validNewPathsCheckEverySegment() {
		assertThat(NameRules.isValidNewPath("Projects/New idea.md")).isTrue();
		assertThat(NameRules.isValidNewPath("Projects/.hidden/x.md")).isFalse();
		assertThat(NameRules.isValidNewPath("Bad[name.md")).isFalse();
		assertThat(NameRules.isValidNewPath("a//b.md")).isFalse();
	}

}
