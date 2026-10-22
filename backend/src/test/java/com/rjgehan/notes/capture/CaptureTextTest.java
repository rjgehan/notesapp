package com.rjgehan.notes.capture;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

import com.rjgehan.notes.settings.TemplatesSettings;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The entry a capture appends, and daily-note templates rendered on the server (API.md §8.5). */
class CaptureTextTest {

	@Test
	void aThoughtIsOneListItemWithItsStamp() {
		assertThat(CaptureText.entry("14:03", "  Call the plumber \n", null, null, null))
			.isEqualTo("- 14:03 Call the plumber\n");
	}

	@Test
	void furtherLinesAreIndentedUnderTheItem() {
		assertThat(CaptureText.entry("14:03", "Shopping\r\n- milk\r\n\r\n- eggs  ", null, null, null))
			.isEqualTo("- 14:03 Shopping\n  - milk\n\n  - eggs\n");
	}

	@Test
	void aSharedUrlBecomesALink() {
		assertThat(CaptureText.entry("t", null, "https://example.com/a b(1)", "A [great] page", null))
			.isEqualTo("- t [A \\[great\\] page](https://example.com/a%20b%281%29)\n");
		assertThat(CaptureText.entry("t", "Read later", "https://example.com/x", null, null))
			.isEqualTo("- t Read later <https://example.com/x>\n");
		assertThat(CaptureText.entry("t", "Line one\nline two", "https://example.com/x", "x", null))
			.isEqualTo("- t Line one\n  line two\n  [x](https://example.com/x)\n");
	}

	@Test
	void aUrlAlreadyInTheTextIsNotRepeated() {
		assertThat(CaptureText.entry("t", "Look https://example.com/x", "https://example.com/x", "Example", null))
			.isEqualTo("- t Look https://example.com/x\n");
	}

	@Test
	void anythingButAWebLinkStaysText() {
		assertThat(CaptureText.entry("t", null, "javascript:alert(1)", null, null)).isEqualTo("- t javascript:alert(1)\n");
	}

	@Test
	void aFileIsEmbeddedOnItsOwnLineUnderItsCaption() {
		assertThat(CaptureText.entry("t", "Whiteboard", null, null, "![[IMG_0001.jpg]]"))
			.isEqualTo("- t Whiteboard\n  ![[IMG_0001.jpg]]\n");
		assertThat(CaptureText.entry("t", null, null, null, "![[IMG_0001.jpg]]")).isEqualTo("- t ![[IMG_0001.jpg]]\n");
	}

	@Test
	void nothingToCapture() {
		assertThat(CaptureText.entry("t", "  \n ", " ", null, null)).isNull();
	}

	@Test
	void templatesRenderLikeTheApp() {
		ZonedDateTime now = ZonedDateTime.of(LocalDateTime.of(2026, 10, 16, 14, 3), ZoneId.of("UTC"));
		TemplatesSettings settings = new TemplatesSettings("Templates", "YYYY-MM-DD", "HH:mm");
		String template = "# {{title}}\n{{date}} {{ TIME }} {{date:dddd}} {{other}} $1";
		assertThat(CaptureText.renderTemplate(template, "2026-10-16", now, settings))
			.isEqualTo("# 2026-10-16\n2026-10-16 14:03 Friday {{other}} $1");
	}

	@Test
	void promptsRenderTheirDefaultAndTheCursorGoes() {
		ZonedDateTime now = ZonedDateTime.of(LocalDateTime.of(2026, 10, 16, 14, 3), ZoneId.of("UTC"));
		TemplatesSettings settings = new TemplatesSettings("Templates", "YYYY-MM-DD", "HH:mm");
		String template = "{{prompt:Mood|ok }} [{{ Prompt: Who }}] {{cursor}}{{prompt:}} {{cursor:1}}";
		assertThat(CaptureText.renderTemplate(template, "2026-10-16", now, settings))
			.isEqualTo("ok [] {{prompt:}} {{cursor:1}}");
	}

}
