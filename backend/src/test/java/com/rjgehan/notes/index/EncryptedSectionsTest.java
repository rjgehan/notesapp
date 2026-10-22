package com.rjgehan.notes.index;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Inline Meld Encrypt sections (ROADMAP item 27): blanked for search, replaced for Ask your vault. */
class EncryptedSectionsTest {

	private static final String LOCK = "🔐";

	private static final String HINT = "💡";

	@Test
	void everyPrefixAndBothSuffixesAreFound() {
		String hidden = "%%" + LOCK + "β " + HINT + "my cat" + HINT + "QUJD+/== " + LOCK + "%%";
		String visible = LOCK + "β QUJD " + LOCK;
		String alpha = "%%" + LOCK + "α QUJD " + LOCK + "%%";
		String obsolete = "%%" + LOCK + " QUJD " + LOCK + "%%";
		String text = "a " + hidden + " b " + visible + " c " + alpha + " d " + obsolete + " e";
		assertThat(EncryptedSections.strip(text)).isEqualTo("a [encrypted] b [encrypted] c [encrypted] d [encrypted] e");
	}

	@Test
	void blankingKeepsEveryOffset() {
		String section = "%%" + LOCK + "β " + HINT + "h" + HINT + "U2VjcmV0 " + LOCK + "%%";
		String text = "line one\nsecret: " + section + " end\nline three";
		String blank = EncryptedSections.blank(text);
		assertThat(blank).hasSameSizeAs(text);
		assertThat(blank).isEqualTo("line one\nsecret: " + " ".repeat(section.length()) + " end\nline three");
	}

	@Test
	void textWithoutSectionsIsReturnedAsIs() {
		String text = "Nothing " + LOCK + " here but a lock emoji " + LOCK + ".";
		assertThat(EncryptedSections.blank(text)).isSameAs(text);
		assertThat(EncryptedSections.strip("plain")).isSameAs("plain");
		// A lock with words that are not base64 between is not a section.
		assertThat(EncryptedSections.strip(text)).isEqualTo(text);
	}

	@Test
	void aSectionNeverSpansLines() {
		String text = "%%" + LOCK + "β QUJD\nQUJD " + LOCK + "%%";
		assertThat(EncryptedSections.blank(text)).isSameAs(text);
	}

	@Test
	void encryptedNotesAreTextThatIsNeverContentIndexed() {
		assertThat(IndexFixtures.KINDS.kindOf("Safe/Bank.mdenc")).isEqualTo(com.rjgehan.notes.api.dto.FileKind.TEXT);
		assertThat(IndexFixtures.KINDS.kindOf("Safe/Bank.MDENC")).isEqualTo(com.rjgehan.notes.api.dto.FileKind.TEXT);
	}

	@Test
	void searchNeverMatchesCiphertextButFindsTheRest() {
		VaultIndex index = new VaultIndex();
		String text = "Bank details %%" + LOCK + "β " + HINT + "usual" + HINT + "U2VjcmV0UGF5bG9hZA== " + LOCK
				+ "%% stored safely\n";
		NoteParse parse = MarkdownScanner.scan(text, false, false);
		byte[] bytes = com.rjgehan.notes.vault.TextCodec.encode(text, false);
		FileRecord record = new FileRecord("Bank.md", IndexFixtures.KINDS.kindOf("Bank.md"), bytes.length,
				java.time.Instant.parse("2026-10-21T12:00:00Z"), com.rjgehan.notes.vault.Hashing.blobId(bytes),
				parse.aliases());
		index.put(new IndexedFile(record, "Bank.md", text, parse));
		assertThat(hits(index, "U2VjcmV0UGF5bG9hZA")).isEmpty();
		assertThat(hits(index, "/U2Vj/")).isEmpty();
		assertThat(hits(index, "usual")).isEmpty();
		assertThat(hits(index, "line:(bank stored)")).containsExactly("Bank.md");
		assertThat(hits(index, "safely")).containsExactly("Bank.md");
	}

	private static java.util.List<String> hits(VaultIndex index, String query) {
		return index
			.search(SearchQueryParser.parse(query),
					new VaultIndex.SearchOptions(true, false, (path) -> false, false, java.time.Duration.ofSeconds(10)))
			.hits()
			.stream()
			.map((hit) -> hit.note().path())
			.toList();
	}

}
