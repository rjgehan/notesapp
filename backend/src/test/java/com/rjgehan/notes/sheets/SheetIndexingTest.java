package com.rjgehan.notes.sheets;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.rjgehan.notes.api.dto.BacklinkGroup;
import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.Mention;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.SearchHit;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.NoteService;
import com.rjgehan.notes.index.SearchService;
import com.rjgehan.notes.index.TagIndex;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Spreadsheets feed search, backlinks and tags through the DocumentIndexer (ROADMAP item 6b, DESIGN §6.21.7). */
class SheetIndexingTest {

	private static final String CLIENT = "client-s1";

	private static final String BUDGET = """
			{
			  "type": "notesapp-sheet",
			  "version": 1,
			  "engine": "hyperformula@3.4.0",
			  "sheets": [
			    {
			      "id": "s1",
			      "name": "Household",
			      "cells": {
			        "A1": { "v": "Item" },
			        "B1": { "v": "Cost" },
			        "A2": { "v": "Call [[Plumber]] about the leak #home" },
			        "B2": { "v": 1450 },
			        "A3": { "f": "=\\"Ask [[\\" & \\"Electrician\\" & \\"]]\\"", "c": "Ask [[Electrician]]" },
			        "B3": { "f": "=SUM(B2:B2)", "c": 1937.5 },
			        "C3": { "f": "=1/0", "c": { "e": "#DIV/0!" } }
			      },
			      "cols": { "B": { "w": 110, "fmt": "$#,##0.00" } },
			      "rows": {},
			      "frozen": { "rows": 1, "cols": 0 },
			      "charts": { "c1": { "type": "bar", "range": "A1:B3", "title": "Quarterly spend" } }
			    }
			  ],
			  "named": {}
			}
			""";

	@TempDir
	Path dir;

	private TestVault vault;

	private NoteService notes;

	private SearchService search;

	@BeforeEach
	void setUp() throws IOException {
		for (String note : List.of("Plumber", "Electrician", "Roofer", "Cost")) {
			write(note + ".md", "# " + note + "\n");
		}
		write("Diary.md", "The Cost went up.\n");
		write("Money/Budget.sheet", BUDGET);
		write("Money/Broken.sheet", "{\"type\": \"notesapp-sheet\", \"sheets\": [ leak");
		this.vault = TestVault.start(this.dir);
		this.notes = new NoteService(this.vault.paths, this.vault.index, this.vault.kinds, this.vault.settings);
		this.search = new SearchService(this.vault.index, this.vault.settings, this.vault.properties);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private void write(String path, String content) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private String read(String path) throws IOException {
		return Files.readString(this.dir.resolve(path), StandardCharsets.UTF_8);
	}

	private List<BacklinkGroup> linked(String path) {
		return this.notes.backlinks(path, false).linked();
	}

	private List<String> contexts(String path, String source) {
		return linked(path).stream()
			.filter((group) -> group.source().equals(source))
			.flatMap((group) -> group.mentions().stream())
			.map(Mention::context)
			.toList();
	}

	private List<String> found(String query) {
		return this.search.search(query, 20, "relevance", false, false).results().stream().map(SearchHit::path).toList();
	}

	@Test
	void linksInCellsAndInCachedResultsAreBacklinks() {
		assertThat(contexts("Plumber.md", "Money/Budget.sheet")).containsExactly("Call [[Plumber]] about the leak #home");
		assertThat(contexts("Electrician.md", "Money/Budget.sheet")).containsExactly("Ask [[Electrician]]");
		assertThat(linked("Roofer.md")).isEmpty();
	}

	@Test
	void searchFindsCellTextAndCachedValuesButNotFormulasOrJson() {
		assertThat(found("leak")).containsExactly("Money/Budget.sheet");
		assertThat(found("1937.5")).containsExactly("Money/Budget.sheet");
		assertThat(found("1450")).containsExactly("Money/Budget.sheet");
		assertThat(found("Household")).containsExactly("Money/Budget.sheet");
		assertThat(found("Quarterly")).containsExactly("Money/Budget.sheet");
		assertThat(found("SUM")).isEmpty();
		assertThat(found("DIV")).isEmpty();
		assertThat(found("hyperformula")).isEmpty();
		assertThat(found("frozen")).isEmpty();
		assertThat(found("tag:home")).containsExactly("Money/Budget.sheet");
		assertThat(this.vault.index.tagStats().stream().map(TagIndex.TagStat::tag).toList()).contains("home");
	}

	@Test
	void aSheetIsNotANoteAndOffersNoMentionsToLink() {
		assertThat(this.vault.index.stats().notes()).isEqualTo(5);
		assertThatThrownBy(() -> this.notes.meta("Money/Budget.sheet")).isInstanceOfSatisfying(NotesException.class,
				(ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.TYPE_MISMATCH));
		// The sheet's B1 says "Cost", but a sheet is never offered as an unlinked mention: the Link action would edit
		// the file at an offset of its search text.
		assertThat(this.notes.backlinks("Cost.md", true).unlinked()).extracting(BacklinkGroup::source)
			.containsExactly("Diary.md");
	}

	@Test
	void aRenameReportsTheSheetAsNotRewritableAndLeavesItAlone() throws IOException {
		MoveResult result = this.vault.moves.move("Plumber.md", "Trades/Plumber Bob.md", null, false, TestVault.ALICE,
				CLIENT);
		assertThat(result.failed()).extracting((f) -> f.path() + " " + f.reason())
			.containsExactly("Money/Budget.sheet " + FailedReason.NOT_REWRITABLE);
		assertThat(read("Money/Budget.sheet")).isEqualTo(BUDGET);
	}

	@Test
	void savedSheetsAreIndexedAgain() throws IOException {
		String version = this.vault.index.file("Money/Budget.sheet").version();
		String edited = BUDGET.replace("Call [[Plumber]] about the leak", "Ask [[Roofer]] about the gutters");
		this.vault.files.saveText("Money/Budget.sheet", edited, version, false, TestVault.ALICE, CLIENT);
		assertThat(linked("Plumber.md")).isEmpty();
		assertThat(contexts("Roofer.md", "Money/Budget.sheet")).containsExactly("Ask [[Roofer]] about the gutters #home");
		assertThat(found("gutters")).containsExactly("Money/Budget.sheet");

		// A sheet that stops being readable keeps its file record and loses its content.
		version = this.vault.index.file("Money/Budget.sheet").version();
		this.vault.files.saveText("Money/Budget.sheet", "{", version, false, TestVault.ALICE, CLIENT);
		assertThat(this.vault.index.file("Money/Budget.sheet")).isNotNull();
		assertThat(linked("Roofer.md")).isEmpty();
		assertThat(found("gutters")).isEmpty();
	}

	@Test
	void anUnreadableSheetIsListedButNotSearched() {
		assertThat(this.vault.index.file("Money/Broken.sheet")).isNotNull();
		assertThat(found("leak")).doesNotContain("Money/Broken.sheet");
	}

}
