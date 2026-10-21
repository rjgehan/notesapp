package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.api.dto.GraphNode;
import com.rjgehan.notes.api.dto.GraphNodeType;
import com.rjgehan.notes.api.dto.GraphResponse;
import org.junit.jupiter.api.Test;

import static com.rjgehan.notes.index.IndexFixtures.file;
import static com.rjgehan.notes.index.IndexFixtures.note;
import static org.assertj.core.api.Assertions.assertThat;

/** The link graph of {@code GET /api/graph} (API.md §11.4) and its version (ROADMAP item 16). */
class GraphBuilderTest {

	private static GraphResponse graph(VaultIndex index) {
		return index.graph((path) -> false, "x", null);
	}

	/** The edges as "source -> target xN" strings, for readable assertions. */
	private static List<String> edges(GraphResponse graph) {
		List<String> edges = new ArrayList<>();
		int[] e = graph.edges();
		for (int i = 0; i < e.length; i += 3) {
			edges.add(graph.nodes().get(e[i]).path() + " -> " + graph.nodes().get(e[i + 1]).path() + " x" + e[i + 2]);
		}
		return edges;
	}

	@Test
	void everyFileIsANodeAndLinksAreCountedPerPair() {
		VaultIndex index = new VaultIndex();
		index.put(note("A.md", "# A\n[[B]] and [[B|again]] and ![[pic.png]] and [[#Self]] and [[A]] #Work #work/deep\n"));
		index.put(note("B.md", "---\ntags: [project]\n---\nBack to [[A]].\n"));
		index.put(note("Lonely.md", "Nothing here.\n"));
		index.put(file("Attachments/pic.png"));
		index.put(file("Attachments/unused.pdf"));

		GraphResponse graph = graph(index);

		assertThat(graph.unchanged()).isFalse();
		assertThat(graph.nodes()).containsExactly(new GraphNode("A.md", GraphNodeType.NOTE, List.of("Work", "work/deep")),
				new GraphNode("Attachments/pic.png", GraphNodeType.ATTACHMENT, List.of()),
				new GraphNode("Attachments/unused.pdf", GraphNodeType.ATTACHMENT, List.of()),
				new GraphNode("B.md", GraphNodeType.NOTE, List.of("project")),
				new GraphNode("Lonely.md", GraphNodeType.NOTE, List.of()));
		// Same-note links ([[#Self]], [[A]] from A) are left out; embeds count as links.
		assertThat(edges(graph)).containsExactly("A.md -> Attachments/pic.png x1", "A.md -> B.md x2", "B.md -> A.md x1");
	}

	@Test
	void unresolvedTargetsAreGroupedCaseInsensitivelyWithoutMd() {
		VaultIndex index = new VaultIndex();
		index.put(note("A.md", "[[Ideas]] [[ideas.md]] [[Folder/Plan]] ![[missing.png]]\n"));
		index.put(note("B.md", "[[IDEAS]]\n"));

		GraphResponse graph = graph(index);

		assertThat(graph.nodes()).extracting(GraphNode::path, GraphNode::type)
			.containsExactly(org.assertj.core.groups.Tuple.tuple("A.md", GraphNodeType.NOTE),
					org.assertj.core.groups.Tuple.tuple("B.md", GraphNodeType.NOTE),
					org.assertj.core.groups.Tuple.tuple("Ideas", GraphNodeType.UNRESOLVED),
					org.assertj.core.groups.Tuple.tuple("Folder/Plan", GraphNodeType.UNRESOLVED),
					org.assertj.core.groups.Tuple.tuple("missing.png", GraphNodeType.UNRESOLVED));
		assertThat(edges(graph)).containsExactly("A.md -> Ideas x2", "A.md -> Folder/Plan x1", "A.md -> missing.png x1",
				"B.md -> Ideas x1");
	}

	@Test
	void excludedFilesAndTheirEdgesAreLeftOut() {
		VaultIndex index = new VaultIndex();
		index.put(note("A.md", "[[Archive/Old]] [[B]]\n"));
		index.put(note("B.md", "x\n"));
		index.put(note("Archive/Old.md", "[[A]] [[Gone]]\n"));

		GraphResponse graph = index.graph((path) -> path.startsWith("Archive/"), "archive", null);

		assertThat(graph.nodes()).extracting(GraphNode::path).containsExactly("A.md", "B.md");
		assertThat(edges(graph)).containsExactly("A.md -> B.md x1");
	}

	@Test
	void theVersionChangesOnlyWhenTheGraphChanges() {
		VaultIndex index = new VaultIndex();
		index.put(note("A.md", "[[B]] #tag\n"));
		index.put(note("B.md", "x\n"));
		String version = graph(index).version();

		assertThat(index.graph((path) -> false, "x", version).unchanged()).isTrue();
		assertThat(index.graph((path) -> false, "x", version).nodes()).isEmpty();
		assertThat(index.graph((path) -> false, "other-exclusions", version).unchanged()).isFalse();

		// Text edits that keep the links and tags keep the version.
		index.put(note("A.md", "Some more words. [[B|shown]] #tag\n"));
		index.put(note("B.md", "y\n"));
		assertThat(graph(index).version()).isEqualTo(version);

		index.put(note("A.md", "[[B]] [[C]] #tag\n"));
		String linked = graph(index).version();
		assertThat(linked).isNotEqualTo(version);

		index.put(note("A.md", "[[B]] [[C]] #Tag\n"));
		String retagged = graph(index).version();
		assertThat(retagged).isNotEqualTo(linked);

		// A new file resolves [[C]]: the graph changes.
		index.put(note("C.md", "z\n"));
		String created = graph(index).version();
		assertThat(created).isNotEqualTo(retagged);
		assertThat(edges(graph(index))).containsExactly("A.md -> B.md x1", "A.md -> C.md x1");

		index.move("C.md", "Moved/C.md", "Moved/C.md");
		String moved = graph(index).version();
		assertThat(moved).isNotEqualTo(created);
		assertThat(edges(graph(index))).containsExactly("A.md -> B.md x1", "A.md -> Moved/C.md x1");

		index.removeFile("B.md");
		assertThat(graph(index).version()).isNotEqualTo(moved);
		assertThat(edges(graph(index))).containsExactly("A.md -> Moved/C.md x1", "A.md -> B x1");
	}

	@Test
	void unresolvedNamesAreTrimmedAndLoseMd() {
		assertThat(GraphBuilder.unresolvedName("  Plan.MD ")).isEqualTo("Plan");
		assertThat(GraphBuilder.unresolvedName(".md")).isNull();
		assertThat(GraphBuilder.unresolvedName("  ")).isNull();
		assertThat(GraphBuilder.unresolvedName("v1.2")).isEqualTo("v1.2");
	}

}
