package com.rjgehan.notes.api;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** Search, tags, backlinks (linked and unlinked), note metadata and link resolution (DESIGN §8.1 integration item 9). */
@NotesIntegrationTest
class SearchAndLinksIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
	}

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private JsonNode create(String path, String content) {
		return this.api.postJson("/api/files", Map.of("path", path, "content", content)).ok(201);
	}

	private JsonNode search(String query) {
		return this.api.get("/api/search?q=" + Api.enc(query)).ok(200);
	}

	private List<String> paths(JsonNode response) {
		List<String> paths = new ArrayList<>();
		response.get("results").forEach((hit) -> paths.add(hit.get("path").asString()));
		return paths;
	}

	private void updateFiles(Consumer<ObjectNode> change) {
		JsonNode current = this.api.get("/api/settings").ok(200);
		ObjectNode settings = (ObjectNode) current.get("settings").deepCopy();
		change.accept((ObjectNode) settings.get("files"));
		this.api.putJson("/api/settings", Map.of("settings", settings, "baseVersion", current.get("version").asString()))
			.ok(200);
	}

	@Test
	void searchFindsPhrasesFiltersAndPrefixes() {
		create("Find/Weekly review.md",
				"---\naliases: [Ruminations]\n---\n# Weekly review\nCovers #work/review items.\n");
		create("Find/Linker.md", "Start with [[Weekly review]] today.\n");
		create("Find/Plain.md", "The weekly review is only mentioned here.\n");

		String query = "\"weekly review\" -tag:work path:find -file:linker";
		JsonNode result = search(query);
		assertThat(result.get("query").asString()).isEqualTo(query);
		assertThat(result.get("total").asInt()).isEqualTo(1);
		assertThat(result.get("tookMs").asLong()).isNotNegative();
		JsonNode hit = result.get("results").get(0);
		assertThat(hit.get("path").asString()).isEqualTo("Find/Plain.md");
		assertThat(hit.get("basename").asString()).isEqualTo("Plain");
		assertThat(hit.get("mtime").asString()).endsWith("Z");
		assertThat(hit.get("titleRanges").isEmpty()).isTrue();
		assertThat(hit.get("moreMatches").asInt()).isZero();
		JsonNode match = hit.get("matches").get(0);
		assertThat(match.get("line").asInt()).isZero();
		assertThat(match.get("text").asString()).isEqualTo("The weekly review is only mentioned here.");
		assertThat(match.get("ranges").get(0).get("from").asInt()).isEqualTo(4);
		assertThat(match.get("ranges").get(0).get("to").asInt()).isEqualTo(17);

		JsonNode titled = search("weekly review");
		assertThat(paths(titled).get(0)).isEqualTo("Find/Weekly review.md");
		assertThat(titled.get("results").get(0).get("titleRanges").get(0).get("to").asInt()).isEqualTo(6);
		JsonNode tagged = search("tag:#work");
		assertThat(paths(tagged)).containsExactly("Find/Weekly review.md");
		assertThat(tagged.get("results").get(0).get("score").asDouble()).isZero();
		assertThat(search("ruminations").get("total").asInt()).isEqualTo(1);
		assertThat(search("weekl").get("total").asInt()).isEqualTo(3);
		assertThat(this.api.get("/api/search?q=weekl&prefix=false&fuzzy=false").ok(200).get("total").asInt()).isZero();
		// Typo tolerance: without the prefix, "weekl" is one edit away from "weekly".
		JsonNode corrected = this.api.get("/api/search?q=weekl&prefix=false").ok(200);
		assertThat(corrected.get("total").asInt()).isEqualTo(3);
		assertThat(corrected.get("corrections").get(0).get("term").asString()).isEqualTo("weekl");
		assertThat(corrected.get("corrections").get(0).get("replacements").get(0).asString()).isEqualTo("weekly");
		assertThat(titled.get("corrections").isEmpty()).isTrue();
		assertThat(titled.get("results").get(0).get("kind").asString()).isEqualTo("note");
		assertThat(search("").get("total").asInt()).isZero();
		assertThat(search("-weekly").get("total").asInt()).isZero();
		assertThat(this.api.get("/api/search").ok(200).get("total").asInt()).isZero();

		JsonNode limited = this.api.get("/api/search?q=weekly&limit=1").ok(200);
		assertThat(limited.get("total").asInt()).isEqualTo(3);
		assertThat(limited.get("results").size()).isEqualTo(1);
		assertThat(this.api.get("/api/search?q=x&limit=0").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/search?q=x&limit=201").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/search?q=x&limit=abc").problem(400)).isEqualTo("bad-request");
		assertThat(this.api.get("/api/search?q=x&sort=size").problem(400)).isEqualTo("bad-request");
	}

	@Test
	void searchSortsByMtimeAndSkipsExcludedPaths() throws Exception {
		create("Sorted/Older.md", "zebra crossing\n");
		Thread.sleep(20);
		create("Sorted/Newer.md", "zebra zebra zebra\n");
		Thread.sleep(20);
		create("Archive/Hidden.md", "zebra\n");
		List<String> byTime = paths(this.api.get("/api/search?q=zebra&sort=mtime").ok(200));
		assertThat(byTime).containsExactly("Archive/Hidden.md", "Sorted/Newer.md", "Sorted/Older.md");
		try {
			updateFiles((files) -> files.putArray("excludedPaths").add("archive"));
			assertThat(paths(search("zebra"))).containsExactlyInAnyOrder("Sorted/Newer.md", "Sorted/Older.md");
		}
		finally {
			updateFiles((files) -> files.putArray("excludedPaths"));
		}
	}

	@Test
	void tagsCountNestedTags() {
		create("Tags/One.md", "---\ntags: [tproj]\n---\n#tproj/alpha and #Tlabel\n");
		create("Tags/Two.md", "#tproj/alpha #tproj/beta\n");
		List<JsonNode> tags = new ArrayList<>();
		this.api.get("/api/tags").ok(200).get("tags").forEach(tags::add);
		List<String> names = tags.stream().map((tag) -> tag.get("tag").asString()).toList();
		List<String> sorted = new ArrayList<>(names);
		Collections.sort(sorted, String.CASE_INSENSITIVE_ORDER);
		assertThat(names).isEqualTo(sorted);
		JsonNode project = tags.stream().filter((tag) -> tag.get("tag").asString().equals("tproj")).findFirst().orElseThrow();
		assertThat(project.get("count").asInt()).isEqualTo(1);
		assertThat(project.get("total").asInt()).isEqualTo(2);
		JsonNode alpha = tags.stream()
			.filter((tag) -> tag.get("tag").asString().equals("tproj/alpha"))
			.findFirst()
			.orElseThrow();
		assertThat(alpha.get("count").asInt()).isEqualTo(2);
		assertThat(alpha.get("total").asInt()).isEqualTo(2);
		assertThat(names).contains("Tlabel");
	}

	@Test
	void backlinksAreLinkedAndUnlinked() {
		create("Back/Quarterly retro.md", "---\naliases: [Postmortem]\n---\n# Quarterly retro\n");
		create("Back/Linker.md", "Start with [[Quarterly retro]] today.\n");
		create("Back/Plain.md", "The quarterly retro is only mentioned here, and a postmortem too.\n");
		create("Back/Code.md", "`quarterly retro` in code, [[Other|quarterly retro]] in a link.\n");
		create("Back/Embeds.md", "![[pic.png]]\n");
		this.api.putBytes("/api/files/raw?path=" + Api.enc("Back/pic.png"), new byte[] { 1 }).ok(201);

		JsonNode backlinks = this.api
			.get("/api/notes/backlinks?unlinked=true&path=" + Api.enc("Back/Quarterly retro.md"))
			.ok(200);
		assertThat(backlinks.get("path").asString()).isEqualTo("Back/Quarterly retro.md");
		JsonNode linked = backlinks.get("linked").get(0);
		assertThat(linked.get("source").asString()).isEqualTo("Back/Linker.md");
		assertThat(linked.get("sourceVersion").asString())
			.isEqualTo(this.api.get("/api/files?path=" + Api.enc("Back/Linker.md")).json().get("version").asString());
		JsonNode mention = linked.get("mentions").get(0);
		assertThat(mention.get("line").asInt()).isZero();
		assertThat(mention.get("from").asInt()).isEqualTo(11);
		assertThat(mention.get("to").asInt()).isEqualTo(30);
		assertThat(mention.get("matched").asString()).isEqualTo("[[Quarterly retro]]");
		assertThat(mention.get("context").asString()).isEqualTo("Start with [[Quarterly retro]] today.");
		assertThat(mention.get("contextRange").get("from").asInt()).isEqualTo(11);
		assertThat(mention.get("contextRange").get("to").asInt()).isEqualTo(30);

		List<String> unlinked = new ArrayList<>();
		backlinks.get("unlinked").forEach((group) -> unlinked.add(group.get("source").asString()));
		assertThat(unlinked).containsExactly("Back/Plain.md");
		JsonNode plain = backlinks.get("unlinked").get(0);
		assertThat(plain.get("mentions").values().stream().map((m) -> m.get("matched").asString()))
			.containsExactly("quarterly retro", "postmortem");

		assertThat(this.api.get("/api/notes/backlinks?path=" + Api.enc("Back/Quarterly retro.md"))
			.ok(200)
			.get("unlinked")
			.isNull()).isTrue();
		JsonNode image = this.api.get("/api/notes/backlinks?unlinked=true&path=" + Api.enc("Back/pic.png")).ok(200);
		assertThat(image.get("linked").get(0).get("source").asString()).isEqualTo("Back/Embeds.md");
		assertThat(image.get("linked").get(0).get("mentions").get(0).get("matched").asString()).isEqualTo("![[pic.png]]");
		assertThat(image.get("unlinked").isEmpty()).isTrue();
	}

	@Test
	void noteMetadataDescribesTheParse() {
		create("Meta/Target.md", "# Target\n");
		create("Meta/Note.md", "---\naliases: [Roadmap]\ntags: [project]\ndue: 2026-11-01\nok: yes\n---\n"
				+ "# Plan\n\nSee [[Target#Top|it]] and #project/alpha and ![[missing.png]].\nA line ^block1\n");
		JsonNode meta = this.api.get("/api/notes/meta?path=" + Api.enc("Meta/Note.md")).ok(200);
		assertThat(meta.get("path").asString()).isEqualTo("Meta/Note.md");
		assertThat(meta.get("version").asString()).matches("[0-9a-f]{40}");
		assertThat(meta.get("frontmatter").get("due").asString()).isEqualTo("2026-11-01");
		assertThat(meta.get("frontmatter").get("ok").asString()).isEqualTo("yes");
		assertThat(meta.get("frontmatterError").isNull()).isTrue();
		assertThat(meta.get("aliases").get(0).asString()).isEqualTo("Roadmap");
		assertThat(meta.get("tags").values().stream().map(JsonNode::asString)).containsExactly("project", "project/alpha");
		assertThat(meta.get("headings").get(0).get("level").asInt()).isEqualTo(1);
		assertThat(meta.get("headings").get(0).get("text").asString()).isEqualTo("Plan");
		assertThat(meta.get("headings").get(0).get("line").asInt()).isEqualTo(6);
		assertThat(meta.get("blockIds").values().stream().map(JsonNode::asString)).containsExactly("block1");
		JsonNode link = meta.get("links").get(0);
		assertThat(link.get("raw").asString()).isEqualTo("[[Target#Top|it]]");
		assertThat(link.get("target").asString()).isEqualTo("Target");
		assertThat(link.get("subpath").asString()).isEqualTo("Top");
		assertThat(link.get("display").asString()).isEqualTo("it");
		assertThat(link.get("embed").asBoolean()).isFalse();
		assertThat(link.get("style").asString()).isEqualTo("wiki");
		assertThat(link.get("line").asInt()).isEqualTo(8);
		assertThat(link.get("inFrontmatter").asBoolean()).isFalse();
		assertThat(link.get("resolved").asString()).isEqualTo("Meta/Target.md");
		String text = this.api.get("/api/files?path=" + Api.enc("Meta/Note.md")).json().get("content").asString();
		assertThat(text.substring(link.get("from").asInt(), link.get("to").asInt())).isEqualTo("[[Target#Top|it]]");
		JsonNode embed = meta.get("links").get(1);
		assertThat(embed.get("embed").asBoolean()).isTrue();
		assertThat(embed.get("resolved").isNull()).isTrue();

		create("Meta/Broken.md", "---\nkey: [unclosed\n---\nbody\n");
		JsonNode broken = this.api.get("/api/notes/meta?path=" + Api.enc("Meta/Broken.md")).ok(200);
		assertThat(broken.get("frontmatter").isNull()).isTrue();
		assertThat(broken.get("frontmatterError").asString()).isNotBlank();

		this.api.putBytes("/api/files/raw?path=" + Api.enc("Meta/crlf.md"),
				"# A\r\n\r\n[[Target]]\r\n".getBytes(StandardCharsets.UTF_8)).ok(201);
		JsonNode crlf = this.api.get("/api/notes/meta?path=" + Api.enc("Meta/crlf.md")).ok(200);
		assertThat(crlf.get("links").get(0).get("from").asInt()).isEqualTo(7);
		assertThat(crlf.get("links").get(0).get("line").asInt()).isEqualTo(2);

		this.api.postJson("/api/files", Map.of("path", "Meta/data.json", "content", "{}")).ok(201);
		var notANote = this.api.get("/api/notes/meta?path=" + Api.enc("Meta/data.json"));
		assertThat(notANote.problem(409)).isEqualTo("type-mismatch");
		assertThat(notANote.json().get("expected").asString()).isEqualTo("note");
		assertThat(this.api.get("/api/notes/meta?path=Meta/Nope.md").problem(404)).isEqualTo("not-found");
	}

	@Test
	void linksResolveWithCreatePaths() {
		for (String path : List.of("Welcome2.md", "Plan.md", "Projects/Plan.md", "Attachments/pic.png",
				"Daily/2026-10-16.md")) {
			if (path.endsWith(".png")) {
				this.api.putBytes("/api/files/raw?path=" + Api.enc(path), new byte[] { 1 }).ok(201);
			}
			else {
				create(path, "");
			}
		}
		JsonNode resolved = this.api.postJson("/api/links/resolve", Map.of("source", "Daily/2026-10-16.md", "targets",
				List.of("Plan", "Projects/New idea", "pic.png", "", "missing.pdf", "Plan", "Bad[name")))
			.ok(200)
			.get("resolved");
		assertThat(resolved.size()).isEqualTo(6);
		assertThat(resolved.get("Plan").get("path").asString()).isEqualTo("Plan.md");
		assertThat(resolved.get("Plan").get("createPath").isNull()).isTrue();
		assertThat(resolved.get("Projects/New idea").get("path").isNull()).isTrue();
		assertThat(resolved.get("Projects/New idea").get("createPath").asString()).isEqualTo("Projects/New idea.md");
		assertThat(resolved.get("pic.png").get("path").asString()).isEqualTo("Attachments/pic.png");
		assertThat(resolved.get("").get("path").asString()).isEqualTo("Daily/2026-10-16.md");
		assertThat(resolved.get("missing.pdf").get("path").isNull()).isTrue();
		assertThat(resolved.get("missing.pdf").get("createPath").isNull()).isTrue();
		assertThat(resolved.get("Bad[name").get("createPath").isNull()).isTrue();

		try {
			updateFiles((files) -> files.put("newNoteLocation", "current"));
			assertThat(this.api.postJson("/api/links/resolve", Map.of("source", "Daily/2026-10-16.md", "targets",
					List.of("Missing"))).ok(200).get("resolved").get("Missing").get("createPath").asString())
				.isEqualTo("Daily/Missing.md");
		}
		finally {
			updateFiles((files) -> files.put("newNoteLocation", "root"));
		}

		assertThat(this.api.postJson("/api/links/resolve", Map.of("source", "Nowhere/x.md", "targets", List.of("Plan")))
			.ok(200)
			.get("resolved")
			.get("Plan")
			.get("path")
			.asString()).isEqualTo("Plan.md");
		assertThat(this.api.postJson("/api/links/resolve", Map.of("source", "a.md", "targets", List.of())).problem(400))
			.isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/links/resolve",
				Map.of("source", "a.md", "targets", Collections.nCopies(501, "x"))).problem(400)).isEqualTo("bad-request");
		assertThat(this.api.postJson("/api/links/resolve",
				Map.of("source", "a.md", "targets", Collections.nCopies(500, "x"))).status()).isEqualTo(200);
		assertThat(this.api.postJson("/api/links/resolve", Map.of("source", "../a.md", "targets", List.of("x")))
			.problem(400)).isEqualTo("invalid-path");
		assertThat(this.api.postJson("/api/links/resolve", Map.of("targets", List.of("x"))).problem(400))
			.isEqualTo("bad-request");
	}

	@Test
	void templatesAreListedFromTheTemplatesFolder() {
		create("Templates/Meeting.md", "# {{title}}\n");
		create("Templates/Sub/Daily note.md", "{{date}}\n");
		create("Templates/data.json", "{}");
		JsonNode templates = this.api.get("/api/templates").ok(200);
		assertThat(templates.get("folder").asString()).isEqualTo("Templates");
		assertThat(templates.get("templates").values().stream().map((t) -> t.get("path").asString()))
			.containsExactly("Templates/Meeting.md", "Templates/Sub/Daily note.md");
		assertThat(templates.get("templates").get(1).get("name").asString()).isEqualTo("Daily note");
	}

}
