package com.rjgehan.notes.publish;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import com.rjgehan.notes.api.dto.FileKind;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The publishing rules of DESIGN §5.26: what a snapshot may and may not contain. */
class PublishRendererTest {

	private static final String NOTE = "Blog/Post.md";

	/** A small vault: Blog/Post.md is published as "post", Blog/Other.md as "other"; the rest is private. */
	private static final class Vault implements PublishRenderer.Context {

		final Map<String, String> files = new HashMap<>();

		final Map<String, String> slugs = new HashMap<>(Map.of(NOTE, "post", "Blog/Other.md", "other"));

		final Map<String, String> titles = new HashMap<>(Map.of(NOTE, "Post", "Blog/Other.md", "Another post"));

		Vault() {
			for (String path : new String[] { NOTE, "Blog/Other.md", "Private/Diary.md", "Private/Secret plan.md",
					"attachments/photo.png", "attachments/huge.png", "attachments/talk.mp3", "attachments/doc.pdf" }) {
				this.files.put(path.toLowerCase(Locale.ROOT), path);
				String name = path.substring(path.lastIndexOf('/') + 1).toLowerCase(Locale.ROOT);
				this.files.putIfAbsent(name, path);
				if (name.endsWith(".md")) {
					this.files.putIfAbsent(name.substring(0, name.length() - 3), path);
				}
			}
		}

		@Override
		public @Nullable String resolve(String target) {
			if (target.isEmpty()) {
				return NOTE;
			}
			String key = target.toLowerCase(Locale.ROOT).replace("%20", " ");
			return this.files.get(key);
		}

		@Override
		public FileKind kindOf(String path) {
			if (path.endsWith(".md")) {
				return FileKind.NOTE;
			}
			if (path.endsWith(".png")) {
				return FileKind.IMAGE;
			}
			if (path.endsWith(".mp3")) {
				return FileKind.AUDIO;
			}
			return path.endsWith(".pdf") ? FileKind.PDF : FileKind.OTHER;
		}

		@Override
		public @Nullable String slugOf(String path) {
			return this.slugs.get(path);
		}

		@Override
		public @Nullable String titleOf(String path) {
			return this.titles.get(path);
		}

		@Override
		public @Nullable String asset(String path) {
			if (path.endsWith("huge.png")) {
				return null;
			}
			return (path.endsWith(".png") ? "0123456789abcdef0123.png" : "fedcba9876543210fedc.mp3");
		}

	}

	private static String render(String markdown) {
		return PublishRenderer.renderBody(NOTE, markdown, new Vault());
	}

	@Test
	void frontmatterCommentsAndRawHtmlAreNeverPublished() {
		String html = render("""
				---
				secret-property: tax id 123
				tags: [private]
				---
				Visible text %% hidden remark %% stays.

				%%
				A whole hidden paragraph
				%%

				<!-- an html comment -->
				<div onclick="steal()">raw block</div>

				Inline <span style="x">span</span> and <script>alert(1)</script> and line<br>break.
				<img src=x onerror=alert(1)>
				""");
		assertThat(html).contains("Visible text").contains("stays.").contains("<br />");
		assertThat(html).doesNotContain("secret-property").doesNotContain("tax id").doesNotContain("hidden remark")
			.doesNotContain("whole hidden").doesNotContain("html comment").doesNotContain("onclick")
			.doesNotContain("raw block").doesNotContain("<script").doesNotContain("<span").doesNotContain("onerror")
			.doesNotContain("<img").doesNotContain("<div");
	}

	@Test
	void linksToNotesThatAreNotPublishedArePlainTextWithoutTheirFolder() {
		String html = render("""
				See [[Private/Diary]], [[Secret plan|my plans]], [[Private/Diary#Monday]] and [the diary](../Private/Diary.md).
				Also [[Other]], [[Other#Part two|part two]], [[#Intro]] and [[Missing note]].
				""");
		assertThat(html).doesNotContain("Private").doesNotContain("Secret plan").doesNotContain("href=\"../")
			.doesNotContain(".md");
		assertThat(html).contains("See Diary, my plans, Diary &gt; Monday and the diary.");
		assertThat(html).contains("<a href=\"/p/other\">Other</a>")
			.contains("<a href=\"/p/other#part-two\">part two</a>")
			.contains("<a href=\"#intro\">Intro</a>")
			.contains("Missing note");
	}

	@Test
	void embedsOfPrivateNotesLeaveNothingAndAttachmentsBecomeAssets() {
		String html = render("""
				![[Secret plan]]
				![[Other]]
				![[photo.png|300]] ![[huge.png]] ![[talk.mp3]] ![[doc.pdf]] ![[nowhere.png]]
				![a photo](attachments/photo.png) ![gone](attachments/nope.png)
				""");
		assertThat(html).doesNotContain("Secret").doesNotContain("huge").doesNotContain("doc.pdf")
			.doesNotContain("nowhere").doesNotContain("gone").doesNotContain("attachments/");
		assertThat(html).contains("<a href=\"/p/other\">Another post</a>");
		assertThat(html).contains("<img src=\"/p/post/0123456789abcdef0123.png\" alt=\"photo\" loading=\"lazy\" width=\"300\" />");
		assertThat(html).contains("<audio src=\"/p/post/fedcba9876543210fedc.mp3\" controls=\"\" preload=\"metadata\"></audio>");
		assertThat(html).contains("alt=\"a photo\"");
	}

	@Test
	void onlyHttpHttpsAndMailtoUrlsBecomeLinks() {
		String html = render("""
				[ok](https://example.com/a?b=1) [mail](mailto:me@example.com) <https://example.org>
				[js](javascript:alert(1)) [data](data:text/html,x) [vault](obsidian://open?vault=x) [file](file:///etc/passwd)
				[ref][r] [proto](//evil.example/x) www.example.net
				![external](https://tracker.example/pixel.png)

				[r]: Private/Diary.md
				""");
		assertThat(html).contains("<a href=\"https://example.com/a?b=1\" rel=\"nofollow noopener noreferrer\">ok</a>")
			.contains("<a href=\"mailto:me@example.com\"")
			.contains("<a href=\"https://example.org\"")
			.contains("<a href=\"http://www.example.net\"");
		assertThat(html).doesNotContain("javascript:").doesNotContain("data:").doesNotContain("obsidian:")
			.doesNotContain("file:").doesNotContain("Private").doesNotContain("evil.example\"")
			.doesNotContain("<img");
		assertThat(html).contains("<a href=\"https://tracker.example/pixel.png\" rel=\"nofollow noopener noreferrer\">external</a>");
	}

	@Test
	void theRenderersMarkerCannotBeForged() {
		String html = render("[forged](notesapp-publish-00:l0) [[Other]] ![x](notesapp-publish-00:m0)");
		assertThat(html).contains("forged").doesNotContain("href=\"notesapp").doesNotContain("<img");
	}

	@Test
	void textOfLinksIsEscaped() {
		String html = render("[[Missing|<b onmouseover=x>bold</b>]] [[Other|*not emphasis* <i>]]");
		assertThat(html).contains("&lt;b onmouseover=x&gt;bold&lt;/b&gt;").contains("*not emphasis* &lt;i&gt;")
			.doesNotContain("<b ").doesNotContain("<em>");
	}

	@Test
	void vaultQueriesBlockIdsAndCalloutsAreCleanedUp() {
		String html = render("""
				# Intro

				A paragraph with an id ^abc123

				```query
				path:"Private/Health"
				```

				```dataview
				TABLE FROM "Private"
				```

				```js
				const kept = true;
				```

				> [!warning] Careful
				> Body text

				- [ ] open task
				- [x] done task

				| a | b |
				|---|---|
				| 1 | 2 |

				~~struck~~ and a footnote[^1].

				[^1]: The note.
				""");
		assertThat(html).doesNotContain("Private").doesNotContain("^abc123").doesNotContain("[!warning]");
		assertThat(html).contains("<h1 id=\"intro\">Intro</h1>").contains("const kept = true;")
			.contains("<strong>Careful</strong>").contains("Body text")
			.contains("type=\"checkbox\"").contains("<table>").contains("<del>struck</del>")
			.contains("The note.");
	}

	@Test
	void theDocumentEscapesItsTitleAndLoadsOnlyItsStylesheet() {
		String page = PublishPage.document("A <b>title</b> & \"more\"", "<p>x</p>\n",
				java.time.Instant.parse("2026-10-21T10:00:00Z"));
		assertThat(page).contains("<title>A &lt;b&gt;title&lt;/b&gt; &amp; &quot;more&quot;</title>")
			.contains("<link rel=\"stylesheet\" href=\"/p/-/style.css\">")
			.contains("noindex")
			.contains("Published 21 October 2026")
			.doesNotContain("<script");
	}

	@Test
	void slugsAreMadeFromTitles() {
		assertThat(PublishService.slugify("My First Post!")).isEqualTo("my-first-post");
		assertThat(PublishService.slugify("Café   déjà-vu")).isEqualTo("cafe-deja-vu");
		assertThat(PublishService.slugify("日本語")).isEmpty();
		assertThat(PublishService.slugify("--a--")).isEqualTo("a");
	}

}
