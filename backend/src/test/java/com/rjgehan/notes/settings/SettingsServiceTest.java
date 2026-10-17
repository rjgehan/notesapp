package com.rjgehan.notes.settings;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.SettingsResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.VersionConflictException;
import com.rjgehan.notes.events.SettingsChangedEvent;
import com.rjgehan.notes.history.GitStore;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.Hashing;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Settings: defaults, validation, the version protocol, unknown fields and read-only mode (DESIGN §5.12). */
class SettingsServiceTest {

	@TempDir
	Path dir;

	private TestVault vault;

	private Path file;

	@BeforeEach
	void setUp() throws Exception {
		this.vault = TestVault.start(this.dir);
		this.file = this.dir.resolve(".notesapp/settings.json");
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private SettingsService service() {
		return this.vault.settings;
	}

	private ObjectNode body(Settings settings) {
		ObjectNode tree = (ObjectNode) TestVault.JSON.valueToTree(settings);
		return tree;
	}

	private ObjectNode defaultsWith(String group, String field, Object value) {
		ObjectNode tree = body(Settings.defaults());
		ObjectNode groupNode = (ObjectNode) tree.get(group);
		groupNode.set(field, TestVault.JSON.valueToTree(value));
		return tree;
	}

	@Test
	void aMissingFileIsCreatedWithDefaults() throws Exception {
		service().load();
		assertThat(this.file).exists();
		SettingsResponse response = service().get();
		assertThat(response.settings()).isEqualTo(Settings.defaults());
		assertThat(response.readOnly()).isFalse();
		assertThat(response.version()).isEqualTo(Hashing.blobId(Files.readAllBytes(this.file)));
		String text = Files.readString(this.file);
		assertThat(text).startsWith("{\n  \"dailyNotes\": {").endsWith("}\n").doesNotContain("\r");
		assertThat(text.indexOf("\"editor\"")).isLessThan(text.indexOf("\"files\""));
	}

	@Test
	void settingsSerializeWithTheWireNames() {
		JsonNode tree = TestVault.JSON.valueToTree(Settings.defaults());
		assertThat(tree.get("files").get("newNoteLocation").asString()).isEqualTo("root");
		assertThat(tree.get("files").get("attachmentLocation").asString()).isEqualTo("folder");
		assertThat(tree.get("editor").get("defaultMode").asString()).isEqualTo("edit");
		assertThat(tree.get("files").get("excludedPaths").isArray()).isTrue();
	}

	@Test
	void aSaveWritesBumpsTheVersionAndAnnouncesIt() throws Exception {
		service().load();
		String base = service().get().version();
		SettingsResponse saved = service().update(defaultsWith("files", "newLinkFormat", "absolute"), base,
				TestVault.ALICE, "client-a1");
		assertThat(saved.settings().files().newLinkFormat()).isEqualTo(LinkFormat.ABSOLUTE);
		assertThat(saved.version()).isNotEqualTo(base).isEqualTo(Hashing.blobId(Files.readAllBytes(this.file)));
		assertThat(service().current().files().newLinkFormat()).isEqualTo(LinkFormat.ABSOLUTE);
		assertThat(this.vault.hub.published).singleElement()
			.isEqualTo(new SettingsChangedEvent(saved.version(), "client-a1"));
		GitStore.Commit commit = this.vault.flush();
		assertThat(commit.paths()).containsExactly(".notesapp/settings.json");
		assertThat(commit.author().email()).isEqualTo("alice@github");
	}

	@Test
	void validationReportsEveryFieldByName() throws Exception {
		service().load();
		ObjectNode tree = defaultsWith("files", "newLinkFormat", "longest");
		((ObjectNode) tree.get("files")).put("newNoteFolder", "../up");
		((ObjectNode) tree.get("files")).put("attachmentSubfolder", "a/b");
		((ObjectNode) tree.get("templates")).put("dateFormat", "");
		((ObjectNode) tree.get("editor")).remove("strictLineBreaks");
		((ObjectNode) tree.get("files")).putArray("excludedPaths").add(".git");
		tree.put("schemaVersion", 2);
		assertThatThrownBy(() -> service().update(tree, service().get().version(), TestVault.ALICE, "client-a1"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST);
				@SuppressWarnings("unchecked")
				List<FieldError> errors = (List<FieldError>) ex.getBody().getProperties().get("errors");
				assertThat(errors).extracting(FieldError::field)
					.containsExactlyInAnyOrder("settings.schemaVersion", "settings.files.newLinkFormat",
							"settings.files.newNoteFolder", "settings.files.attachmentSubfolder",
							"settings.files.excludedPaths[0]", "settings.templates.dateFormat",
							"settings.editor.strictLineBreaks");
			});
		ObjectNode missingGroup = body(Settings.defaults());
		missingGroup.remove("dailyNotes");
		assertThatThrownBy(() -> service().update(missingGroup, service().get().version(), TestVault.ALICE, "c-1234567"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.getMessage()).contains("dailyNotes"));
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void aStaleBaseIsAConflictCarryingTheServerCopy() throws Exception {
		service().load();
		String base = service().get().version();
		service().update(defaultsWith("files", "useWikilinks", false), base, TestVault.ALICE, "client-a1");
		assertThatThrownBy(() -> service().update(defaultsWith("files", "autoUpdateLinks", false), base,
				TestVault.BOB, "client-b1"))
			.isInstanceOfSatisfying(VersionConflictException.class, (ex) -> {
				Map<String, Object> properties = ex.getBody().getProperties();
				assertThat(properties.get("currentVersion")).isEqualTo(service().get().version());
				assertThat((String) properties.get("currentContent")).contains("\"useWikilinks\": false");
				assertThat(properties).containsEntry("movedTo", null);
			});
	}

	@Test
	void equalContentIsNeverAConflict() throws Exception {
		service().load();
		String base = service().get().version();
		SettingsResponse first = service().update(defaultsWith("editor", "readableLineLength", false), base,
				TestVault.ALICE, "client-a1");
		this.vault.hub.published.clear();
		SettingsResponse retried = service().update(defaultsWith("editor", "readableLineLength", false), base,
				TestVault.ALICE, "client-a1");
		assertThat(retried.version()).isEqualTo(first.version());
		assertThat(this.vault.hub.published).isEmpty();
	}

	@Test
	void unknownFieldsSurviveAWrite() throws Exception {
		Files.createDirectories(this.file.getParent());
		ObjectNode tree = body(Settings.defaults());
		tree.put("futureTopLevel", 42);
		((ObjectNode) tree.get("files")).put("futureFlag", true);
		Files.writeString(this.file, TestVault.JSON.writeValueAsString(tree));
		service().load();
		assertThat(service().isReadOnly()).isFalse();
		service().update(defaultsWith("files", "newNoteFolder", "Inbox"), service().get().version(), TestVault.ALICE,
				"client-a1");
		JsonNode written = TestVault.JSON.readTree(Files.readString(this.file));
		assertThat(written.get("futureTopLevel").asInt()).isEqualTo(42);
		assertThat(written.get("files").get("futureFlag").asBoolean()).isTrue();
		assertThat(written.get("files").get("newNoteFolder").asString()).isEqualTo("Inbox");
	}

	@Test
	void aNewerSchemaVersionMakesSettingsReadOnlyAndLeavesTheFileAlone() throws Exception {
		Files.createDirectories(this.file.getParent());
		ObjectNode tree = body(Settings.defaults());
		tree.put("schemaVersion", 2);
		((ObjectNode) tree.get("files")).put("newLinkFormat", "relative");
		((ObjectNode) tree.get("files")).put("attachmentLocation", "cloud");
		byte[] original = TestVault.JSON.writeValueAsBytes(tree);
		Files.write(this.file, original);
		service().load();
		assertThat(service().isReadOnly()).isTrue();
		assertThat(service().readOnlyReason()).contains("newer version");
		assertThat(service().current().files().newLinkFormat()).isEqualTo(LinkFormat.RELATIVE);
		assertThat(service().current().files().attachmentLocation()).isEqualTo(AttachmentLocation.FOLDER);
		assertThat(service().get().readOnly()).isTrue();
		assertThatThrownBy(() -> service().update(body(Settings.defaults()), service().get().version(),
				TestVault.ALICE, "client-a1"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.SETTINGS_READ_ONLY);
				assertThat(ex.getBody().getProperties()).containsKey("reason");
			});
		assertThat(Files.readAllBytes(this.file)).isEqualTo(original);
	}

	@Test
	void anInvalidFileOfThisSchemaIsReadOnlyToo() throws Exception {
		Files.createDirectories(this.file.getParent());
		ObjectNode tree = body(Settings.defaults());
		((ObjectNode) tree.get("editor")).put("defaultMode", "split");
		byte[] original = TestVault.JSON.writeValueAsBytes(tree);
		Files.write(this.file, original);
		service().load();
		assertThat(service().isReadOnly()).isTrue();
		assertThat(service().readOnlyReason()).contains("settings.editor.defaultMode");
		assertThat(Files.readAllBytes(this.file)).isEqualTo(original);
	}

	@Test
	void aFileThatIsNotJsonIsBackedUpAndReplaced() throws Exception {
		Files.createDirectories(this.file.getParent());
		Files.writeString(this.file, "{ not json", StandardCharsets.UTF_8);
		service().load();
		assertThat(service().isReadOnly()).isFalse();
		assertThat(service().current()).isEqualTo(Settings.defaults());
		try (var listing = Files.list(this.file.getParent())) {
			assertThat(listing.map((p) -> p.getFileName().toString()))
				.anyMatch((name) -> name.startsWith("settings.json.bak-"));
		}
		assertThat(TestVault.JSON.readTree(Files.readString(this.file)).get("schemaVersion").asInt()).isEqualTo(1);
	}

	@Test
	void excludedPathsAreFolderOrFilePrefixesMatchedIgnoringCase() {
		FilesSettings files = new FilesSettings(NewNoteLocation.ROOT, "", LinkFormat.SHORTEST, true,
				AttachmentLocation.FOLDER, "Attachments", "attachments", true,
				List.of("Archive", "Private.md", "Daily/2025"));
		assertThat(files.isExcluded("archive/old.md")).isTrue();
		assertThat(files.isExcluded("Archive/2025/Deep.md")).isTrue();
		assertThat(files.isExcluded("private.md")).isTrue();
		assertThat(files.isExcluded("Daily/2025/01.md")).isTrue();
		assertThat(files.isExcluded("Archived.md")).isFalse();
		assertThat(files.isExcluded("Private.md.txt")).isFalse();
		assertThat(files.isExcluded("Daily/2025-10-16.md")).isFalse();
		assertThat(files.isExcluded("Notes/private.md")).isFalse();
	}

}
