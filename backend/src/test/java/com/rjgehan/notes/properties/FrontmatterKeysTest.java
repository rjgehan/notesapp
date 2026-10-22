package com.rjgehan.notes.properties;

import com.rjgehan.notes.properties.FrontmatterKeys.Result;
import com.rjgehan.notes.properties.FrontmatterKeys.Status;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Renaming a frontmatter key in place (ROADMAP item 13, DESIGN §5.38). */
class FrontmatterKeysTest {

	private static String renamed(String text, String from, String to) {
		Result result = FrontmatterKeys.rename(text, from, to);
		assertThat(result.status()).isEqualTo(Status.RENAMED);
		return result.text();
	}

	@Test
	void onlyTheKeyChangesEverythingElseStaysByteForByte() {
		String text = """
				---
				# a comment
				title:   "Plan"   # trailing comment
				Status: in progress
				tags:
				  - a   # item comment
				  - b

				due: 2026-10-21
				---
				Body with Status: here
				""";
		assertThat(renamed(text, "status", "state")).isEqualTo(text.replace("Status: in progress", "state: in progress"));
	}

	@Test
	void crlfAndBlockValuesAreKept() {
		String text = "---\r\nsummary: |\r\n  line one\r\n  line two\r\nnext: 1\r\n---\r\nbody\r\n";
		assertThat(renamed(text, "summary", "abstract")).isEqualTo(text.replace("summary:", "abstract:"));
	}

	@Test
	void quotedKeysAndNamesThatNeedQuotes() {
		assertThat(renamed("---\n\"due date\": 1\n---\n", "due date", "due")).isEqualTo("---\ndue: 1\n---\n");
		assertThat(renamed("---\n'a': 1\n---\n", "a", "b")).isEqualTo("---\nb: 1\n---\n");
		assertThat(renamed("---\na: 1\n---\n", "a", "b: c")).isEqualTo("---\n\"b: c\": 1\n---\n");
		assertThat(renamed("---\na: 1\n---\n", "a", "true")).isEqualTo("---\n\"true\": 1\n---\n");
		assertThat(renamed("---\na: 1\n---\n", "a", "2026")).isEqualTo("---\n\"2026\": 1\n---\n");
		assertThat(renamed("---\na: 1\n---\n", "a", "Über Café")).isEqualTo("---\nÜber Café: 1\n---\n");
	}

	@Test
	void namesCompareCaseInsensitivelyAndDuplicatesAllRename() {
		assertThat(renamed("---\nTopic: x\nother: y\ntopic: z\n---\n", "TOPIC", "subject"))
			.isEqualTo("---\nsubject: x\nother: y\nsubject: z\n---\n");
		// Changing only the case is a rename too.
		assertThat(renamed("---\nstatus: x\n---\n", "status", "Status")).isEqualTo("---\nStatus: x\n---\n");
	}

	@Test
	void absentConflictingAndUnrewritableNotesAreLeftAlone() {
		assertThat(FrontmatterKeys.rename("no frontmatter\nstatus: x\n", "status", "s").status())
			.isEqualTo(Status.ABSENT);
		assertThat(FrontmatterKeys.rename("---\nother: 1\n---\n", "status", "s").status()).isEqualTo(Status.ABSENT);
		assertThat(FrontmatterKeys.rename("---\nstatus: [\n---\n", "status", "s").status()).isEqualTo(Status.ABSENT);
		assertThat(FrontmatterKeys.rename("---\nstatus: 1\nState: 2\n---\n", "status", "state").status())
			.isEqualTo(Status.CONFLICT);
		assertThat(FrontmatterKeys.rename("---\n{status: 1, b: 2}\n---\n", "status", "s").status())
			.isEqualTo(Status.NOT_REWRITABLE);
		assertThat(FrontmatterKeys.rename("---\n!!str status: 1\n---\n", "status", "s").status())
			.isEqualTo(Status.NOT_REWRITABLE);
		assertThat(FrontmatterKeys.rename("---\n? status\n: 1\n---\n", "status", "s").status())
			.isEqualTo(Status.NOT_REWRITABLE);
	}

	@Test
	void nestedKeysWithTheSameNameAreNotTouched() {
		String text = "---\nmeta:\n  status: inner\nstatus: outer\n---\n";
		assertThat(renamed(text, "status", "state")).isEqualTo("---\nmeta:\n  status: inner\nstate: outer\n---\n");
	}

}
