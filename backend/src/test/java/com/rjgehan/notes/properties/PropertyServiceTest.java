package com.rjgehan.notes.properties;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import com.rjgehan.notes.api.dto.FailedReason;
import com.rjgehan.notes.api.dto.FailedUpdate;
import com.rjgehan.notes.api.dto.PropertyInfo;
import com.rjgehan.notes.api.dto.PropertyRenameResult;
import com.rjgehan.notes.api.dto.PropertyTypesResponse;
import com.rjgehan.notes.api.dto.PropertyUpdate;
import com.rjgehan.notes.api.dto.PropertyValue;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.FileEvent;
import com.rjgehan.notes.events.HistoryCommittedEvent;
import com.rjgehan.notes.events.PropertyTypesChangedEvent;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The property list, values, types and renames across the vault (ROADMAP item 13, API.md §38). */
class PropertyServiceTest {

	private static final String CLIENT = "client-a1";

	@TempDir
	Path dir;

	private TestVault vault;

	private PropertyTypeService types;

	private PropertyService properties;

	@AfterEach
	void tearDown() {
		if (this.vault != null) {
			this.vault.close();
		}
	}

	private void write(String path, String content) throws IOException {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	private String read(String path) throws IOException {
		return Files.readString(this.dir.resolve(path), StandardCharsets.UTF_8);
	}

	private void start() throws IOException {
		this.vault = TestVault.start(this.dir);
		this.types = new PropertyTypeService(this.vault.fs, this.vault.batcher, this.vault.hub, TestVault.JSON);
		this.properties = new PropertyService(this.vault.fs, this.vault.locks, this.vault.index, this.vault.files,
				this.vault.indexer, this.vault.reconciler, this.vault.batcher, this.vault.hub, this.types);
	}

	@Test
	void theListCountsNotesPerNameAndInfersTypes() throws Exception {
		write("a.md", "---\nStatus: open\ndue: 2026-10-21\nrating: 4\ntags: [x]\n---\n");
		write("b.md", "---\nstatus: done\ndue: 2026-10-22T09:30\ndone: true\n---\n");
		write("c.md", "---\nstatus: open\nempty:\n---\n");
		write("d.md", "no properties\n");
		start();
		assertThat(this.properties.list().properties()).containsExactly(
				new PropertyInfo("done", 1, null, "checkbox"), new PropertyInfo("due", 2, null, "date"),
				new PropertyInfo("empty", 1, null, "text"), new PropertyInfo("rating", 1, null, "number"),
				new PropertyInfo("status", 3, null, "text"), new PropertyInfo("tags", 1, null, "multitext"));
		this.types.set("Rating", "text", TestVault.ALICE, CLIENT);
		assertThat(this.properties.list().properties()).contains(new PropertyInfo("rating", 1, "text", "number"));
	}

	@Test
	void valuesCountNotesAndSplitLists() throws Exception {
		write("a.md", "---\ntopics: [Alpha, beta]\n---\n");
		write("b.md", "---\nTopics:\n  - Alpha\n  - Alpha\n---\n");
		write("c.md", "---\ntopics: gamma\n---\n");
		start();
		assertThat(this.properties.values("topics").values()).containsExactly(new PropertyValue("Alpha", 2),
				new PropertyValue("beta", 1), new PropertyValue("gamma", 1));
	}

	@Test
	void typesAreReadFromObsidianUntilTheFirstChangeThenKeptInNotesApp() throws Exception {
		write(".obsidian/types.json", "{\n  \"types\": {\n    \"due\": \"date\",\n    \"odd\": 3\n  }\n}");
		start();
		PropertyTypesResponse initial = this.types.get();
		assertThat(initial.types()).containsExactly(Map.entry("due", "date"));
		assertThat(initial.source()).isEqualTo("obsidian");
		assertThat(initial.version()).isNull();

		PropertyTypesResponse changed = this.types.set("Rating", "number", TestVault.ALICE, CLIENT);
		assertThat(changed.types()).containsExactly(Map.entry("due", "date"), Map.entry("Rating", "number"));
		assertThat(changed.source()).isEqualTo("notesapp");
		assertThat(read(".notesapp/types.json"))
			.isEqualTo("{\n  \"types\": {\n    \"due\": \"date\",\n    \"Rating\": \"number\"\n  }\n}\n");
		assertThat(this.vault.hub.published).filteredOn(PropertyTypesChangedEvent.class::isInstance)
			.singleElement()
			.satisfies((e) -> assertThat(((PropertyTypesChangedEvent) e).version()).isEqualTo(changed.version()));

		// The same name in another case replaces the entry; null removes it; the same type changes nothing.
		assertThat(this.types.set("rating", "text", TestVault.ALICE, CLIENT).types())
			.containsExactly(Map.entry("due", "date"), Map.entry("rating", "text"));
		String version = this.types.get().version();
		assertThat(this.types.set("rating", "text", TestVault.ALICE, CLIENT).version()).isEqualTo(version);
		assertThat(this.types.set("RATING", null, TestVault.ALICE, CLIENT).types())
			.containsExactly(Map.entry("due", "date"));
		assertThatThrownBy(() -> this.types.set("x", "colour", TestVault.ALICE, CLIENT))
			.isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> this.types.set(" ", "text", TestVault.ALICE, CLIENT))
			.isInstanceOf(NotesException.class);
	}

	@Test
	void renameRewritesOnlyTheKeysCommitsOnceAndMovesTheType() throws Exception {
		String a = "---\n# kept\nStatus: open  # why\nother: 1\n---\nStatus: in the body\n";
		write("a.md", a);
		write("b.md", "---\nstatus:\n  - x\n---\n");
		write("c.md", "---\nstatus: 1\nstate: 2\n---\n");
		write("d.md", "---\nother: status\n---\n");
		start();
		this.types.set("status", "text", TestVault.ALICE, CLIENT);
		this.vault.flush();

		PropertyRenameResult preview = this.properties.rename("status", "state", true, TestVault.ALICE, CLIENT);
		assertThat(preview.updates()).containsExactly(new PropertyUpdate("a.md", null),
				new PropertyUpdate("b.md", null));
		assertThat(preview.failed()).containsExactly(new FailedUpdate("c.md", FailedReason.PROPERTY_EXISTS));
		assertThat(preview.typeMoved()).isTrue();
		assertThat(read("a.md")).isEqualTo(a);

		PropertyRenameResult result = this.properties.rename("status", "state", false, TestVault.ALICE, CLIENT);
		assertThat(result.updates()).extracting(PropertyUpdate::path).containsExactly("a.md", "b.md");
		assertThat(result.updates()).allSatisfy((u) -> assertThat(u.version()).isNotNull());
		assertThat(result.failed()).containsExactly(new FailedUpdate("c.md", FailedReason.PROPERTY_EXISTS));
		assertThat(read("a.md")).isEqualTo("---\n# kept\nstate: open  # why\nother: 1\n---\nStatus: in the body\n");
		assertThat(read("b.md")).isEqualTo("---\nstate:\n  - x\n---\n");
		assertThat(read("c.md")).isEqualTo("---\nstatus: 1\nstate: 2\n---\n");
		assertThat(this.types.get().types()).containsExactly(Map.entry("state", "text"));
		assertThat(this.vault.hub.published).filteredOn(FileEvent.class::isInstance)
			.extracting((e) -> ((FileEvent) e).file().path())
			.containsExactly("a.md", "b.md");
		HistoryCommittedEvent commit = this.vault.hub.published.stream()
			.filter(HistoryCommittedEvent.class::isInstance)
			.map(HistoryCommittedEvent.class::cast)
			.filter((c) -> c.message().startsWith("Rename property"))
			.findFirst()
			.orElseThrow();
		assertThat(commit.message()).isEqualTo("Rename property “status” → “state” (2 notes)");
		assertThat(commit.paths()).containsExactly("a.md", "b.md");
		assertThat(result.commitId()).isEqualTo(commit.commitId());
		// The index follows: the list shows the new name.
		assertThat(this.properties.list().properties()).extracting(PropertyInfo::name, PropertyInfo::count)
			.contains(org.assertj.core.groups.Tuple.tuple("state", 3), org.assertj.core.groups.Tuple.tuple("status", 1));
	}

	@Test
	void anExternalEditIsReadFromDiskNotReverted() throws Exception {
		write("a.md", "---\nstatus: open\n---\nold body\n");
		start();
		// Changed on disk behind the watcher's back.
		write("a.md", "---\nstatus: open\n---\nnew body\n");
		PropertyRenameResult result = this.properties.rename("status", "phase", false, TestVault.ALICE, CLIENT);
		assertThat(result.updates()).extracting(PropertyUpdate::path).containsExactly("a.md");
		assertThat(read("a.md")).isEqualTo("---\nphase: open\n---\nnew body\n");
	}

	@Test
	void invalidRenamesAreRejected() throws Exception {
		start();
		assertThatThrownBy(() -> this.properties.rename("a", "a", false, TestVault.ALICE, CLIENT))
			.isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> this.properties.rename("a", "b\nc", false, TestVault.ALICE, CLIENT))
			.isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> this.properties.rename(null, "b", false, TestVault.ALICE, CLIENT))
			.isInstanceOf(NotesException.class);
	}

}
