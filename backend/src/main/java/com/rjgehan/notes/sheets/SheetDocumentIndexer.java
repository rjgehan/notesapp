package com.rjgehan.notes.sheets;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.index.DocumentIndexer;
import com.rjgehan.notes.vault.PathNames;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * Indexes {@code .sheet} spreadsheets for search, backlinks and tags (ROADMAP item 6b, DESIGN §6.21.7). What a cell
 * shows is a block of its own: its text or number, or the cached {@code c} value of its formula (the frontend writes
 * every formula's result into the file, so no engine runs here), and the values an array formula spilled into other
 * cells. A {@code [[Note]]} written in a cell, or computed by a formula, is therefore a backlink, and a {@code #tag}
 * a tag, as in a note; one block per cell keeps markup in one cell from reaching into the next. Sheet names and chart
 * titles are searchable too. Formulas themselves, error results, number formats and the JSON around the values are
 * not indexed. Files that are not readable sheets are not content-indexed.
 */
@Component
public class SheetDocumentIndexer implements DocumentIndexer {

	private static final String EXTENSION = ".sheet";

	private static final String TYPE = "notesapp-sheet";

	private static final int VERSION = 1;

	private static final Pattern CELL = Pattern.compile("([A-Z]{1,3})([1-9][0-9]{0,6})");

	private static final BigDecimal LARGE = new BigDecimal("1e15");

	private static final BigDecimal SMALL = new BigDecimal("1e-6");

	private final JsonMapper mapper;

	public SheetDocumentIndexer(JsonMapper mapper) {
		this.mapper = mapper;
	}

	@Override
	public boolean supports(String path) {
		return PathNames.lower(path).endsWith(EXTENSION);
	}

	@Override
	public @Nullable Document index(String path, String text) {
		String body = text.startsWith("﻿") ? text.substring(1) : text;
		if (body.isBlank()) {
			// A new, empty file opens as an empty workbook.
			return new Document(List.of());
		}
		JsonNode root;
		try {
			root = this.mapper.readTree(body);
		}
		catch (JacksonException ex) {
			return null;
		}
		if (root == null || !root.isObject() || !isText(root.get("type"), TYPE)) {
			return null;
		}
		JsonNode version = root.get("version");
		if (version != null && !(version.isIntegralNumber() && version.canConvertToInt() && version.intValue() == VERSION)) {
			// A newer format is shown read-only by the frontend until NotesApp is updated; its layout is unknown.
			return null;
		}
		List<String> blocks = new ArrayList<>();
		JsonNode sheets = root.get("sheets");
		if (sheets != null && sheets.isArray()) {
			for (JsonNode sheet : sheets.values()) {
				if (sheet.isObject()) {
					addSheet(blocks, sheet);
				}
			}
		}
		return new Document(List.copyOf(blocks));
	}

	private static void addSheet(List<String> blocks, JsonNode sheet) {
		String name = scalarText(sheet.get("name"));
		if (name != null && !name.isBlank()) {
			blocks.add(oneLine(name));
		}
		JsonNode cells = sheet.get("cells");
		if (cells != null && cells.isObject()) {
			// Row-major, as the grid shows them and the file stores them.
			Map<Long, String> shown = new TreeMap<>();
			for (Map.Entry<String, JsonNode> entry : cells.properties()) {
				long position = position(entry.getKey());
				String value = shownText(entry.getValue());
				if (position >= 0 && value != null && !value.isBlank()) {
					shown.put(position, value);
				}
			}
			blocks.addAll(shown.values());
		}
		JsonNode charts = sheet.get("charts");
		if (charts != null && charts.isObject()) {
			charts.properties()
				.stream()
				.sorted(Map.Entry.comparingByKey(Comparator.naturalOrder()))
				.map((entry) -> entry.getValue().isObject() ? scalarText(entry.getValue().get("title")) : null)
				.filter((title) -> title != null && !title.isBlank())
				.forEach((title) -> blocks.add(oneLine(title)));
		}
	}

	/**
	 * What a cell shows, as the grid does: a formula's cached result, otherwise the literal value, otherwise the
	 * cached value alone (a value an array formula spilled into the cell). A bare value is a literal.
	 */
	static @Nullable String shownText(JsonNode cell) {
		if (!cell.isObject()) {
			return scalarText(cell);
		}
		JsonNode formula = cell.get("f");
		if (formula != null && formula.isString() && !formula.stringValue().isBlank()) {
			return scalarText(cell.get("c"));
		}
		String literal = scalarText(cell.get("v"));
		return (literal != null) ? literal : scalarText(cell.get("c"));
	}

	/** Text, a number as the grid's Automatic format writes it, or TRUE/FALSE; null for anything else. */
	static @Nullable String scalarText(@Nullable JsonNode node) {
		if (node == null) {
			return null;
		}
		if (node.isString()) {
			return node.stringValue();
		}
		if (node.isBoolean()) {
			return node.booleanValue() ? "TRUE" : "FALSE";
		}
		if (node.isNumber()) {
			return number(node);
		}
		// null, an error result ({"e": "#DIV/0!"}) or a value this version cannot show.
		return null;
	}

	private static @Nullable String number(JsonNode node) {
		if (node.isIntegralNumber()) {
			return node.bigIntegerValue().toString();
		}
		double value = node.doubleValue();
		if (!Double.isFinite(value)) {
			return null;
		}
		BigDecimal decimal = BigDecimal.valueOf(value).stripTrailingZeros();
		if (decimal.signum() == 0) {
			return "0";
		}
		BigDecimal magnitude = decimal.abs();
		return (magnitude.compareTo(LARGE) >= 0 || magnitude.compareTo(SMALL) < 0) ? decimal.toString()
				: decimal.toPlainString();
	}

	/** A sortable row-major position for a cell key ({@code B10}, {@code b10}, {@code $B$10}), or -1. */
	static long position(String key) {
		Matcher m = CELL.matcher(key.strip().toUpperCase(Locale.ROOT).replace("$", ""));
		if (!m.matches()) {
			return -1;
		}
		long column = 0;
		for (char letter : m.group(1).toCharArray()) {
			column = column * 26 + (letter - 'A' + 1);
		}
		return Long.parseLong(m.group(2)) * 100_000 + column;
	}

	private static boolean isText(@Nullable JsonNode node, String expected) {
		return node != null && node.isString() && expected.equals(node.stringValue());
	}

	private static String oneLine(String text) {
		return text.replace('\r', ' ').replace('\n', ' ');
	}

}
