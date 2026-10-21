package com.rjgehan.notes.drawings;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The vectors are lz-string 1.5.0's own output ({@code LZString.compressToBase64}, the package the editor and the
 * Obsidian plugin use), generated with Node from the frontend's dependency.
 */
class LzStringTest {

	static final String JSON_SCENE = "{\n\t\"type\": \"excalidraw\",\n\t\"version\": 2,\n\t\"elements\": [\n\t\t{\n"
			+ "\t\t\t\"id\": \"Ab12Cd34\",\n\t\t\t\"type\": \"text\",\n\t\t\t\"text\": \"Hello [[World]]\",\n"
			+ "\t\t\t\"originalText\": \"Hello [[World]]\",\n\t\t\t\"version\": 3,\n\t\t\t\"versionNonce\": 42,\n"
			+ "\t\t\t\"isDeleted\": false,\n\t\t\t\"link\": null\n\t\t}\n\t],\n\t\"appState\": {\n"
			+ "\t\t\"viewBackgroundColor\": \"#ffffff\"\n\t},\n\t\"files\": {}\n}";

	static final String JSON_SCENE_COMPRESSED = "N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCp"
			+ "AzoQPYB2KqATLZAnwIAtgg5Rm3ANrgwoMAogluEAIIAjAIw8AwsQDMAFhqzIsRCqhYoJhWesqAEoPxtUUqQHU2pfMQC6/raKPoQA5oQc"
			+ "BAAqDmgQzviu7l4+foHBkIws7Fxo+vyK2aycAHKc2EhohnymSswAIoIIVsTcAGYEzAiFkEQcANbcHACuSbIAvuD+/BC4cHAAylC4Vtzy"
			+ "WYQIFABCuNgDYaRsIxzEOmyupCoAxO33DxDgE7PthEKSaMBTE0A==";

	/** 3000 printable characters in a pseudo-random order, with a line break every 13. */
	static String longText() {
		StringBuilder out = new StringBuilder();
		for (int i = 0; i < 3000; i++) {
			out.append((char) (32 + ((i * 7919) % 95)));
			if (i % 13 == 0) {
				out.append('\n');
			}
		}
		return out.toString();
	}

	static final String LONG_COMPRESSED = "AQKAQgJg5Akg1gOgAoCcCsB1AngHgHogCEAwgKYAUAUgDYD0AigM4BsAG"
			+ "gF4C8IA+gEQARAGYBKANIBbAAwAlAC4B2AJoBvEAD4ABgGIAogHMAVABkAdgEYAygFcAHAC0QAHwD8AQwAkAMQAWAagBZAHsAJgAVADc"
			+ "AThAAbQBfAAEAIwBSAHEASwAaADkABwBmAFUAdxAALgAdAD8AQQBjADIACQArAFoAeQBHABYANRAADwBuAF1gSFhEVDQQbHwSChoGRhA"
			+ "2Ln5hcWkZEEVVLT0jM3MQGwdXT19AoJBw6ISUjJzckCKy6vrm9o6QXqDMaTabwEDIdCLPDLKggOhMTacbaiECSWSHFTHAwgEwWS72a7e"
			+ "ED+YKPKLPNIgLJ5T6lb6NECtTqAgbAqYgaDwCGYXDQkBkKjwlgcJEgQSiNHyZSYkA6Ay4qx2AkgdzeEmhSLkkBJNLUgolOkgWqNJndfq"
			+ "skATKac2aQkC8mGrBEgEXI3bokDSrGnPEgJWE26kkCaimvGkgA3037MkDmtmgxAgOZQx3UEBrRFusQgPYY72GEBnfEBnwgO5k0PpEBvW"
			+ "lRpogP4s+MQEAzbkp4ggFZCzN8EA7SV5zQgE4K4suEA3dUV+IgF562tVEA/U1N0YgEE29tYEBLAVO4UgLbi91SkBHOU+xUgK6qwMakBP"
			+ "HVh/UgL7G6NmkBAq0J5AgSEHX3OgQARV0T0kEB0S9S8TBAPF/TvfwQFJENnyyEAaUjD9WhAZk41/aAQC5ZMgNIEBBQzcCBBACVcxg7QQ"
			+ "HlItELcEA1XLNDEhAXUa2wmoQBNRsCPGEBrTbUicBAaFgKo9gQCRCD6KUEBMVgljbBAAkkM4iIQHJdC+OKEA6Rw4S+hAVlCIklAQB5Pd"
			+ "uwYEBhWPAdpBAKUL1HMwQEVW8p0CEANSfecchAfV3xXdoQDNH9N1gEBbXsmSKBAA9e2EEBTyHPQQCvcdPBAe8ZxSEAX0XeoQE/NdJnAL"
			+ "dJIIVM5O4LNlLUfMNMcEtdJiSsjPKOtzKGZsbPmDtHKYDZqLo2QDgY5iLAuViOOCB4uN4vIPn4oTOgBETxLBbcHNhHtppEVE2u9HFOoD"
			+ "YketDKl+qjRkhvjDlRpTfkJpc0UlOgo5ZW8hCrhVALUKebVQqwr4jSi/CgUteKSLtMjKOdM7B09LyFqsP1/JW0JgxCjaCgjSKdu6WM4o"
			+ "OxMGtTdMwNciUc3+tTR0LYHtKnMtwYM+dq2h0yVwbeGrM3VtkeSkguzRn7+H7GbPLUkccfHScCZnOcScXZcKbXDcae3XcUtltgj0Utzo"
			+ "PPNnVesG8uY1sJHz57XCjfIW9Z6b8xcNpAAKl2TQLlpSoKVjr4L8h3bhQ4KXdeTCIo9348Nin3pmIpLxoo9LqNo7KGKY/LWPY4quJ48r"
			+ "+ME6qRLEv9JOkprGYU1r/tUjrga07rwf0vroZMwb4cskbkbs8a0ecjKZo8nKFt8gqVqCkqNvCiqdpimqDsSo6TbS06maywd5rysdlqK6"
			+ "d1rKhdtqq1d9rqj7eSIWTGZav6lY0dTOecHTebiQzBcqGZUWIxrKSwWKjA8U0manjmtjK8S18b3jWsTF8W1yafj2tTBM4I6b7jhM1N0F"
			+ "1WZXRPogu6vMHpX3QS9UWb16qASWF9U2roxSWzDoDW2IMf6x1iJDV2MMgGp2GIjX2KNjrpRdNAzG818p4yjtOImccFxkyTquKmactxJg"
			+ "YSbGgDNg4DhZmHWCHNI6uCAA===";

	private static String decompress(String input) {
		return LzString.decompressFromBase64(input, MarkdownDrawing.MAX_JSON_LENGTH);
	}

	@Test
	void decompressesLzStringOutput() {
		assertThat(decompress("Q===")).isEmpty();
		assertThat(decompress("IZA=")).isEqualTo("a");
		assertThat(decompress("BIUwNmD2A0AEDukBOYAmBCIA")).isEqualTo("Hello, world!");
		assertThat(decompress("IYI17SOrZig=")).isEqualTo("abababababababababababababababababababab");
		assertThat(decompress("OIJwPw+wpgNABGAdge4MYDeAmBLugUAjkFPTQGnNA8qMDsGQMYZBahkE6GQCYY4BDRTOKAWwHsArASziAeDcAV"
				+ "+4HhyQPB/cABQBnAK4gQXAOZMALlBkBKIA"))
			.isEqualTo("Grüße, ünïcödé — 日本語のテキスト and emoji 🎨✏️ (surrogates)");
		assertThat(decompress(JSON_SCENE_COMPRESSED)).isEqualTo(JSON_SCENE);
		assertThat(decompress(LONG_COMPRESSED)).isEqualTo(longText());
	}

	@Test
	void ignoresThePluginsLineBreaksBetweenChunks() {
		// The Obsidian plugin writes the data in 256-character chunks separated by blank lines.
		List<String> chunks = new ArrayList<>();
		for (int i = 0; i < LONG_COMPRESSED.length(); i += 256) {
			chunks.add(LONG_COMPRESSED.substring(i, Math.min(LONG_COMPRESSED.length(), i + 256)));
		}
		assertThat(decompress(String.join("\r\n\r\n", chunks) + "\n")).isEqualTo(longText());
	}

	@Test
	void invalidInputBehavesLikeLzString() {
		// lz-string: null for an empty input or a reference past the dictionary, "" when the data ends early.
		assertThat(decompress("")).isNull();
		assertThat(decompress(" \n ")).isNull();
		assertThat(decompress("/////////")).isNull();
		assertThat(decompress("!!!!")).isEmpty();
		assertThat(decompress("BIUwNm")).isEmpty();
	}

	@Test
	void refusesOutputLongerThanTheLimit() {
		assertThat(LzString.decompressFromBase64(LONG_COMPRESSED, 2999)).isNull();
		assertThat(LzString.decompressFromBase64(LONG_COMPRESSED, longText().length())).isEqualTo(longText());
	}

}
