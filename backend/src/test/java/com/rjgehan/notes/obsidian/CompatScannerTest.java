package com.rjgehan.notes.obsidian;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import com.rjgehan.notes.api.dto.CompatIssue;
import com.rjgehan.notes.api.dto.CompatOccurrence;
import com.rjgehan.notes.api.dto.SkipReason;
import com.rjgehan.notes.api.dto.SkippedEntry;
import com.rjgehan.notes.index.VaultIndex;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The findings of the compatibility report on the fixture vault (ROADMAP item 24). */
class CompatScannerTest {

	private static Map<String, CompatIssue> scanFixture() {
		VaultIndex index = ObsidianFixture.index();
		List<CompatIssue> issues = CompatScanner.scan(index.noteViews(), index.filesUnder(""),
				List.of(new SkippedEntry("Bad\\name.md", SkipReason.UNSAFE_NAME)), ObsidianFixture.KINDS::kindOf);
		return issues.stream().collect(Collectors.toMap(CompatIssue::id, (i) -> i));
	}

	private static List<String> where(CompatIssue issue) {
		return issue.occurrences().stream().map((o) -> o.path() + ":" + o.line()).toList();
	}

	@Test
	void findsUnsupportedSyntaxOutsideCode() {
		Map<String, CompatIssue> issues = scanFixture();
		// Plan.md's ```dataview TABLE runs since ROADMAP item 17; Home.md's inline query does not.
		assertThat(where(issues.get("dataview"))).containsExactly("Home.md:19");
		assertThat(where(issues.get("plugin-blocks"))).containsExactly("Projects/Plan.md:15");
		assertThat(where(issues.get("tasks-query"))).containsExactly("Projects/Plan.md:19");
		// Callouts, Mermaid and math render since ROADMAP item 3: no longer findings.
		assertThat(issues).doesNotContainKeys("callouts", "mermaid", "math");
		// Kanban boards open as boards since ROADMAP item 15.
		assertThat(issues).doesNotContainKey("kanban");
		// Templater in the template, not in Code.md's fence or code span.
		assertThat(where(issues.get("templater"))).containsExactly("Templates/Daily.md:0");
		assertThat(where(issues.get("obsidian-uris"))).containsExactly("Home.md:9");
		assertThat(where(issues.get("html-removed"))).containsExactly("Home.md:20");
		// Block references and embeds work since ROADMAP item 20: no longer a finding (missing blocks still are).
		assertThat(issues).doesNotContainKey("block-references");
		assertThat(issues.get("dataview").roadmapItem()).isNull();
		assertThat(issues.get("dataview").category()).isEqualTo(CompatIssue.Category.SYNTAX);
	}

	@Test
	void findsLinksThatLeadNowhere() {
		Map<String, CompatIssue> issues = scanFixture();
		assertThat(issues.get("missing-files").occurrences()).extracting(CompatOccurrence::text)
			.containsExactly("![[missing.png]]");
		assertThat(issues.get("missing-notes").occurrences()).extracting(CompatOccurrence::text)
			.containsExactly("[[Someday]]");
		assertThat(issues.get("missing-headings").occurrences()).extracting(CompatOccurrence::text)
			.containsExactly("[[Plan#Missing heading]]");
		assertThat(issues.get("missing-blocks").occurrences()).extracting(CompatOccurrence::text)
			.containsExactly("[[Plan#^nope]]");
	}

	@Test
	void findsFilesNotesAppCannotUseFully() {
		Map<String, CompatIssue> issues = scanFixture();
		assertThat(where(issues.get("frontmatter"))).containsExactly("Broken.md:0");
		// A drawing named .excalidraw.md opens in the drawing editor (ROADMAP item 5).
		assertThat(issues).doesNotContainKey("excalidraw");
		assertThat(where(issues.get("canvas"))).containsExactly("Map.canvas:null");
		assertThat(issues.get("skipped").occurrences().get(0).text()).isEqualTo("Bad\\name.md (unsafe-name)");
		assertThat(issues.get("skipped").severity()).isEqualTo(CompatIssue.Severity.ERROR);
		assertThat(issues).doesNotContainKeys("too-large", "not-utf8", "bases");
	}

	@Test
	void listsIssuesInRuleOrder() {
		VaultIndex index = ObsidianFixture.index();
		List<String> ids = CompatScanner
			.scan(index.noteViews(), index.filesUnder(""), List.of(), ObsidianFixture.KINDS::kindOf)
			.stream()
			.map(CompatIssue::id)
			.toList();
		assertThat(ids).containsSubsequence("dataview", "templater", "missing-files", "missing-notes", "frontmatter",
				"canvas");
	}

	@Test
	void capsOccurrencesButCountsAll() {
		VaultIndex index = new VaultIndex();
		StringBuilder text = new StringBuilder();
		for (int i = 0; i < 250; i++) {
			text.append("[[Missing ").append(i).append("]]\n");
		}
		index.put(ObsidianFixture.note("Many.md", text.toString()));
		CompatIssue issue = CompatScanner
			.scan(index.noteViews(), index.filesUnder(""), List.of(), ObsidianFixture.KINDS::kindOf)
			.get(0);
		assertThat(issue.id()).isEqualTo("missing-notes");
		assertThat(issue.count()).isEqualTo(250);
		assertThat(issue.noteCount()).isEqualTo(1);
		assertThat(issue.occurrences()).hasSize(CompatScanner.MAX_OCCURRENCES);
		assertThat(issue.truncated()).isTrue();
	}

	@Test
	void reportsOnlyDataviewQueriesTheSubsetDoesNotRun() {
		VaultIndex index = new VaultIndex();
		index.put(ObsidianFixture.note("Q.md", String.join("\n", "```dataview", "LIST FROM #a AND \"Projects\"", "WHERE x > 1",
				"SORT file.name DESC", "```", "", "```dataview", "TABLE length(rows) GROUP BY status", "```", "", "```dataviewjs",
				"dv.list([])", "```", "", "```script", "show(1)", "```", "", "```dataview", "CALENDAR file.mtime")));
		CompatIssue issue = CompatScanner
			.scan(index.noteViews(), index.filesUnder(""), List.of(), ObsidianFixture.KINDS::kindOf)
			.stream()
			.filter((i) -> i.id().equals("dataview"))
			.findFirst()
			.orElseThrow();
		assertThat(where(issue)).containsExactly("Q.md:6", "Q.md:10", "Q.md:18");
		assertThat(issue.occurrences().get(0).text()).contains("GROUP BY");
	}

	@Test
	void tellsTheDataviewSubsetFromTheRest() {
		assertThat(CompatScanner.dataviewUnsupported("TABLE file.name FROM #project")).isFalse();
		assertThat(CompatScanner.dataviewUnsupported("task from [[Home]] where !completed")).isFalse();
		assertThat(CompatScanner.dataviewUnsupported("LIST WHERE file.size - 1 > 0")).isFalse();
		assertThat(CompatScanner.dataviewUnsupported("")).isFalse();
		assertThat(CompatScanner.dataviewUnsupported("LIST FROM #a OR #b")).isTrue();
		assertThat(CompatScanner.dataviewUnsupported("LIST FROM #a AND -#b")).isTrue();
		assertThat(CompatScanner.dataviewUnsupported("LIST FROM \"x\" FLATTEN tags")).isTrue();
		assertThat(CompatScanner.dataviewUnsupported("CALENDAR file.mtime")).isTrue();
	}

	@Test
	void blanksCodeSpans() {
		assertThat(CompatScanner.stripCodeSpans("a `<% x %>` b ``c ` d`` e"))
			.isEqualTo("a" + " ".repeat(11) + "b" + " ".repeat(11) + "e");
		assertThat(CompatScanner.stripCodeSpans("unclosed `tick")).isEqualTo("unclosed `tick");
	}

}
