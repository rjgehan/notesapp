package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.rjgehan.notes.settings.NewNoteLocation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

class LinkResolverTest {

	private final VaultIndex index = IndexFixtures.index(IndexFixtures.API_VAULT);

	private String createPath(String target, String source, NewNoteLocation location, String folder) {
		return LinkResolver.createPath(target, source, location, folder, IndexFixtures.KINDS::isKnownExtension);
	}

	/** API.md §15.1 vectors with default settings (21 and 22 change the settings; see below). */
	@ParameterizedTest(name = "{index}: [[{1}]] from {0}")
	@CsvSource(delimiter = '|', nullValues = "null", value = {
			"Daily/2026-10-16.md     | Plan              | Plan.md                 | null",
			"Projects/Alpha/Spec.md  | Plan              | Plan.md                 | null",
			"Projects/Alpha/notes.md | Spec              | Projects/Alpha/Spec.md  | null",
			"Daily/2026-10-16.md     | Spec              | Archive/Spec.md         | null",
			"Archive/2025/Old.md     | Spec              | Archive/Spec.md         | null",
			"Daily/2026-10-16.md     | Alpha/Spec        | Projects/Alpha/Spec.md  | null",
			"Projects/Alpha/Spec.md  | ../Plan           | Projects/Plan.md        | null",
			"Projects/Alpha/Spec.md  | ./notes           | Projects/Alpha/notes.md | null",
			"Projects/Alpha/Spec.md  | /Plan             | Plan.md                 | null",
			"Welcome.md              | LOG               | log.md                  | null",
			"Welcome.md              | v1.2 notes        | v1.2 notes.md           | null",
			"Welcome.md              | pic.png           | Attachments/pic.png     | null",
			"Welcome.md              | Plan.md           | Plan.md                 | null",
			"Welcome.md              | ''                | Welcome.md              | null",
			"Welcome.md              | Plan B            | Ideas/Plan B.md         | null",
			"Welcome.md              | Missing           | null                    | Missing.md",
			"Daily/2026-10-16.md     | Projects/New idea | null                    | Projects/New idea.md",
			"Projects/Alpha/Spec.md  | ./Draft           | null                    | Projects/Alpha/Draft.md",
			"Welcome.md              | missing.pdf       | null                    | null",
			"Welcome.md              | /Spec             | null                    | Spec.md",
			"Welcome.md              | Bad[name          | null                    | null",
			"Welcome.md              | v1.3              | null                    | v1.3.md",
			"Welcome.md              | Budget.csv        | null                    | null" })
	void apiVectors(String source, String target, String expectedPath, String expectedCreatePath) {
		String resolved = this.index.resolveLink(target, source);
		assertThat(resolved).isEqualTo(expectedPath);
		if (resolved == null) {
			assertThat(createPath(target, source, NewNoteLocation.ROOT, "")).isEqualTo(expectedCreatePath);
		}
	}

	@Test
	void createPathFollowsNewNoteLocation() {
		assertThat(createPath("Missing", "Daily/2026-10-16.md", NewNoteLocation.CURRENT, ""))
			.isEqualTo("Daily/Missing.md");
		assertThat(createPath("Missing", "Daily/2026-10-16.md", NewNoteLocation.FOLDER, "Inbox"))
			.isEqualTo("Inbox/Missing.md");
	}

	@Test
	void createPathRejectsEscapesAndHiddenSegments() {
		assertThat(createPath("../../x", "a/b.md", NewNoteLocation.ROOT, "")).isNull();
		assertThat(createPath(".hidden", "a.md", NewNoteLocation.ROOT, "")).isNull();
		assertThat(createPath("v1.3 notes", "a.md", NewNoteLocation.ROOT, "")).isEqualTo("v1.3 notes.md");
		assertThat(createPath("Notes.MD", "a.md", NewNoteLocation.ROOT, "")).isEqualTo("Notes.MD");
	}

	/** The rule the client's createPath shares (API.md §15.1): only a known kind's extension blocks a create. */
	@Test
	void createPathAppendsMdUnlessTheTargetHasAKnownKindExtension() {
		assertThat(createPath("v1.3", "a.md", NewNoteLocation.ROOT, "")).isEqualTo("v1.3.md");
		assertThat(createPath("Report.final", "a.md", NewNoteLocation.ROOT, "")).isEqualTo("Report.final.md");
		assertThat(createPath("Budget.CSV", "a.md", NewNoteLocation.ROOT, "")).isNull();
		assertThat(createPath("clip.webm", "a.md", NewNoteLocation.ROOT, "")).isNull();
	}

	@Test
	void caseVariantDuplicatesResolveDeterministically() {
		VaultIndex duplicates = IndexFixtures.index(List.of("Dup.md", "dup.md", "x/Other.md"));
		assertThat(duplicates.resolveLink("dup", "x/Other.md")).isEqualTo("dup.md");
		assertThat(duplicates.resolveLink("Dup", "x/Other.md")).isEqualTo("Dup.md");
		assertThat(duplicates.resolveLink("DUP", "x/Other.md")).isEqualTo("Dup.md");
	}

	@Test
	void sameFolderWinsSuffixTies() {
		VaultIndex vault = IndexFixtures.index(List.of("a/x/Note.md", "b/Note.md", "a/x/Source.md"));
		assertThat(vault.resolveLink("Note", "a/x/Source.md")).isEqualTo("a/x/Note.md");
		assertThat(vault.resolveLink("Note", "c/Source.md")).isEqualTo("b/Note.md");
	}

	// ------------------------------------------------------------ re-resolution

	@Test
	void linksReResolveWhenTheirTargetIsCreatedDeletedOrMoved() {
		VaultIndex vault = new VaultIndex();
		vault.put(IndexFixtures.note("Linker.md", "See [[Target]] and [[Other/A]]."));
		assertThat(target(vault, "Linker.md", 0)).isNull();

		IndexFixtures.put(vault, "Target.md");
		assertThat(target(vault, "Linker.md", 0)).isEqualTo("Target.md");
		assertThat(vault.backlinkSources("Target.md")).containsExactly("Linker.md");

		vault.removeFile("Target.md");
		assertThat(target(vault, "Linker.md", 0)).isNull();
		assertThat(vault.backlinkSources("Target.md")).isEmpty();

		IndexFixtures.put(vault, "Sub/Target.md");
		assertThat(target(vault, "Linker.md", 0)).isEqualTo("Sub/Target.md");

		vault.removeFolder("Sub");
		assertThat(target(vault, "Linker.md", 0)).isNull();
	}

	@Test
	void aRootFileTakesOverAWeakerMatch() {
		VaultIndex vault = new VaultIndex();
		IndexFixtures.put(vault, "Other/A.md");
		vault.put(IndexFixtures.note("Source.md", "[[A]]"));
		assertThat(target(vault, "Source.md", 0)).isEqualTo("Other/A.md");
		IndexFixtures.put(vault, "A.md");
		assertThat(target(vault, "Source.md", 0)).isEqualTo("A.md");
	}

	@Test
	void resolutionHappensAtSwapTimeSoAConcurrentlyCreatedTargetIsNeverMissed() throws Exception {
		for (int round = 0; round < 200; round++) {
			VaultIndex vault = new VaultIndex();
			IndexedFile parsed = IndexFixtures.note("Source.md", "[[Fresh]]");
			CountDownLatch start = new CountDownLatch(1);
			ExecutorService pool = Executors.newFixedThreadPool(2);
			List<Future<?>> tasks = new ArrayList<>();
			tasks.add(pool.submit(() -> {
				start.await();
				vault.put(parsed);
				return null;
			}));
			tasks.add(pool.submit(() -> {
				start.await();
				IndexFixtures.put(vault, "Fresh.md");
				return null;
			}));
			start.countDown();
			for (Future<?> task : tasks) {
				task.get();
			}
			pool.shutdown();
			assertThat(target(vault, "Source.md", 0)).isEqualTo("Fresh.md");
			assertThat(vault.backlinkSources("Fresh.md")).containsExactly("Source.md");
		}
	}

	private static String target(VaultIndex vault, String source, int link) {
		return vault.outgoingLinks(source).get(link).target();
	}

}
