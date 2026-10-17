package com.rjgehan.notes.startup;

import java.nio.charset.StandardCharsets;
import java.util.List;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WelcomeContentTest {

	/**
	 * The reading view renders single line breaks as {@code <br>} (DESIGN §6.7, {@code strictLineBreaks} off), so a
	 * paragraph or list item wrapped in the source would show its sentences broken mid-line.
	 */
	@Test
	void everyParagraphAndListItemIsOneLine() throws Exception {
		String text = new String(new WelcomeContent().bytes(), StandardCharsets.UTF_8);
		List<String> lines = text.lines().toList();
		int body = lines.subList(1, lines.size()).indexOf("---") + 2;
		for (int i = body + 1; i < lines.size(); i++) {
			String line = lines.get(i);
			String previous = lines.get(i - 1);
			if (line.isBlank() || previous.isBlank()) {
				continue;
			}
			// Only list items, table rows and headings may sit on adjacent lines.
			assertThat(line).as("line %d continues line %d", i + 1, i).matches("^(- |\\||#).*");
			assertThat(previous).as("line %d is followed by line %d", i, i + 1).matches("^(- |\\||#).*");
		}
	}

}
