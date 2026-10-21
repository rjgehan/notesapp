package com.rjgehan.notes.sheets;

import java.util.List;

import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SheetDocumentIndexerTest {

	private final SheetDocumentIndexer indexer = new SheetDocumentIndexer(TestVault.JSON);

	private List<String> blocks(String text) {
		DocumentIndexer.Document document = this.indexer.index("Budget.sheet", text);
		assertThat(document).isNotNull();
		return document.blocks();
	}

	private static String sheet(String cells) {
		return sheet(cells, "");
	}

	private static String sheet(String cells, String more) {
		return """
				{
				  "type": "notesapp-sheet",
				  "version": 1,
				  "engine": "hyperformula@3.4.0",
				  "sheets": [
				    {
				      "id": "s1",
				      "name": "Budget",
				      "cells": %s%s
				    }
				  ],
				  "named": { "Total": "Budget!$B$10" }
				}
				""".formatted(cells, more);
	}

	@Test
	void supportsSheetFilesOnly() {
		assertThat(this.indexer.supports("Money/Budget.sheet")).isTrue();
		assertThat(this.indexer.supports("Money/Budget.SHEET")).isTrue();
		assertThat(this.indexer.supports("Budget.sheet.md")).isFalse();
		assertThat(this.indexer.supports("Budget.md")).isFalse();
		assertThat(this.indexer.supports("Budget.tasks")).isFalse();
	}

	@Test
	void whatEachCellShowsIsABlockInRowMajorOrder() {
		String text = sheet("""
				{
				        "B10": { "f": "=SUM(B2:B9)", "c": 1937.5 },
				        "A1": { "v": "Item" },
				        "B1": { "v": "Cost" },
				        "A2": { "v": "Rent for [[Flat]]" },
				        "B2": { "v": 1450 },
				        "C2": { "v": true },
				        "AA1": { "v": "far right" },
				        "A3": { "f": "=\\"See [[\\" & A4 & \\"]]\\"", "c": "See [[Plumber]]" },
				        "D1": { "f": "=SEQUENCE(2)", "c": 1 },
				        "D2": { "c": 2 },
				        "E1": { "f": "=1/0", "c": { "e": "#DIV/0!" } },
				        "E2": { "v": "", "fmt": "0%" },
				        "F1": { "fmt": "0.00" }
				      }""");
		assertThat(blocks(text)).containsExactly("Budget", "Item", "Cost", "1", "far right", "Rent for [[Flat]]", "1450",
				"TRUE", "2", "See [[Plumber]]", "1937.5");
	}

	@Test
	void numbersReadAsTheGridShowsThemWithoutAFormat() {
		String text = sheet("""
				{ "A1": { "v": 0.1 }, "A2": { "v": 1450.0 }, "A3": { "v": -2.5e-7 }, "A4": { "v": 1e21 },
				  "A5": { "v": 12345678901234567890 }, "A6": { "v": 0 }, "A7": { "v": -0.0 } }""");
		assertThat(blocks(text)).containsExactly("Budget", "0.1", "1450", "-2.5E-7", "1E+21", "12345678901234567890",
				"0", "0");
	}

	@Test
	void handWrittenCellsAreReadAsTheEditorRepairsThem() {
		String text = sheet("""
				{ "b2": 5, "$A$1": "bare text", "A2": { "v": "kept", "f": "=1+1", "c": 2 }, "A3": { "v": { "x": 1 }, "c": 7 },
				  "not a cell": { "v": "skipped" }, "A4": null, "A5": { "f": "", "v": "empty formula" } }""");
		assertThat(blocks(text)).containsExactly("Budget", "bare text", "2", "5", "7", "empty formula");
	}

	@Test
	void sheetNamesAndChartTitlesAreSearchable() {
		String text = """
				{
				  "type": "notesapp-sheet",
				  "version": 1,
				  "sheets": [
				    { "id": "s1", "name": "Budget", "cells": { "A1": { "v": "x" } },
				      "charts": { "c2": { "type": "pie", "range": "A1:B4", "title": "Split by [[Category]]" },
				                  "c1": { "type": "bar", "range": "A1:B4", "title": "Monthly\\ncosts" },
				                  "c3": { "type": "line", "range": "A1:B4" } } },
				    { "id": "s2", "name": 2026, "cells": {} },
				    { "id": "s3", "cells": { "A1": "unnamed" } },
				    "not a sheet"
				  ]
				}
				""";
		assertThat(blocks(text)).containsExactly("Budget", "x", "Monthly costs", "Split by [[Category]]", "2026",
				"unnamed");
	}

	@Test
	void emptyAndNewFilesAreEmptyDocuments() {
		assertThat(blocks("")).isEmpty();
		assertThat(blocks("  \n")).isEmpty();
		assertThat(blocks("﻿" + sheet("{ \"A1\": { \"v\": \"after a BOM\" } }"))).containsExactly("Budget",
				"after a BOM");
		assertThat(blocks("{\"type\": \"notesapp-sheet\"}")).isEmpty();
	}

	@Test
	void filesThatAreNotReadableSheetsAreNotContentIndexed() {
		assertThat(this.indexer.index("A.sheet", "{\"type\": \"notesapp-sheet\", \"sheets\": [")).isNull();
		assertThat(this.indexer.index("A.sheet", "[1, 2]")).isNull();
		assertThat(this.indexer.index("A.sheet", "{\"type\": \"excalidraw\", \"elements\": []}")).isNull();
		assertThat(this.indexer.index("A.sheet", "{\"type\": \"notesapp-sheet\", \"version\": 2, \"sheets\": []}"))
			.isNull();
		assertThat(this.indexer.index("A.sheet", "{\"type\": \"notesapp-sheet\", \"version\": \"1\"}")).isNull();
	}

}
