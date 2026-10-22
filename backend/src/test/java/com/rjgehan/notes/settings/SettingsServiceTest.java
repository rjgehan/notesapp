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
import tools.jackson.databind.node.ArrayNode;
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
		assertThat(text).startsWith("{\n  \"ai\": {").endsWith("}\n").doesNotContain("\r");
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
	void folderTemplatesAreOptionalValidatedAndSaved() throws Exception {
		service().load();
		// Settings written before folder templates existed have no such field: not an error.
		ObjectNode old = body(Settings.defaults());
		((ObjectNode) old.get("templates")).remove("folderTemplates");
		SettingsResponse saved = service().update(old, service().get().version(), TestVault.ALICE, "client-a1");
		assertThat(saved.settings().templates().folderTemplates()).isEmpty();

		ObjectNode tree = body(Settings.defaults());
		ArrayNode rules = ((ObjectNode) tree.get("templates")).putArray("folderTemplates");
		rules.addObject().put("folder", "Meetings").put("template", "Templates/Meeting.md");
		rules.addObject().put("folder", "").put("template", "");
		saved = service().update(tree, saved.version(), TestVault.ALICE, "client-a1");
		assertThat(saved.settings().templates().folderTemplates()).containsExactly(
				new TemplatesSettings.FolderTemplate("Meetings", "Templates/Meeting.md"),
				new TemplatesSettings.FolderTemplate("", ""));
		JsonNode onDisk = TestVault.JSON.readTree(Files.readString(this.file));
		assertThat(onDisk.get("templates").get("folderTemplates").get(0).get("template").asString())
			.isEqualTo("Templates/Meeting.md");

		rules.addObject().put("folder", "Meetings").put("template", "Templates/Other.md");
		rules.addObject().put("folder", "../up").put("template", "x.md");
		String version = saved.version();
		assertThatThrownBy(() -> service().update(tree, version, TestVault.ALICE, "client-a1"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				@SuppressWarnings("unchecked")
				List<FieldError> errors = (List<FieldError>) ex.getBody().getProperties().get("errors");
				assertThat(errors).extracting(FieldError::field)
					.containsExactly("settings.templates.folderTemplates[2].folder");
			});
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
	void aFileFromBeforeTheAiGroupIsValidAndGetsItsDefaults() throws Exception {
		ObjectNode tree = body(Settings.defaults());
		tree.remove("ai");
		Files.createDirectories(this.file.getParent());
		Files.writeString(this.file, TestVault.JSON.writeValueAsString(tree));
		service().load();
		assertThat(service().isReadOnly()).isFalse();
		assertThat(service().current().ai()).isEqualTo(AiSettings.defaults());
		assertThat(service().current().ai().enabled()).isFalse();
	}

	@Test
	void remindersAreOffByDefaultAndValidatedFieldByField() throws Exception {
		ObjectNode tree = body(Settings.defaults());
		tree.remove("reminders");
		Files.createDirectories(this.file.getParent());
		Files.writeString(this.file, TestVault.JSON.writeValueAsString(tree));
		service().load();
		assertThat(service().isReadOnly()).isFalse();
		assertThat(service().current().reminders()).isEqualTo(RemindersSettings.defaults());
		assertThat(RemindersSettings.defaults().anyRoute()).isFalse();
		assertThat(RemindersSettings.defaults().ntfyTitleOnly()).isTrue();

		ObjectNode bad = body(Settings.defaults());
		ObjectNode reminders = (ObjectNode) bad.get("reminders");
		reminders.put("webPush", "yes");
		reminders.put("dailyNoteTime", "25:00");
		assertThatThrownBy(() -> service().update(bad, service().get().version(), TestVault.ALICE, "client-a1"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				@SuppressWarnings("unchecked")
				List<FieldError> errors = (List<FieldError>) ex.getBody().getProperties().get("errors");
				assertThat(errors).extracting(FieldError::field)
					.containsExactlyInAnyOrder("settings.reminders.webPush", "settings.reminders.dailyNoteTime");
			});

		ObjectNode on = body(Settings.defaults());
		((ObjectNode) on.get("reminders")).put("ntfy", true).put("dailyNote", true).put("dailyNoteTime", "07:30");
		service().update(on, service().get().version(), TestVault.ALICE, "client-a1");
		assertThat(service().current().reminders())
			.isEqualTo(new RemindersSettings(false, true, true, false, true, "07:30"));
		// An old page sends no "reminders": they stay as they were.
		ObjectNode old = defaultsWith("files", "useWikilinks", false);
		old.remove("reminders");
		service().update(old, service().get().version(), TestVault.BOB, "client-b1");
		assertThat(service().current().reminders().ntfy()).isTrue();
	}

	@Test
	void aiSettingsAreValidatedFieldByField() throws Exception {
		service().load();
		ObjectNode tree = body(Settings.defaults());
		ObjectNode ai = (ObjectNode) tree.get("ai");
		ai.put("model", "gpt-9");
		ai.put("maxContextChars", 100);
		ai.put("monthlyBudgetUsd", 0);
		ai.putArray("excludedPaths").add("../up");
		ai.put("enabled", "yes");
		assertThatThrownBy(() -> service().update(tree, service().get().version(), TestVault.ALICE, "client-a1"))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				@SuppressWarnings("unchecked")
				List<FieldError> errors = (List<FieldError>) ex.getBody().getProperties().get("errors");
				assertThat(errors).extracting(FieldError::field)
					.containsExactlyInAnyOrder("settings.ai.model", "settings.ai.maxContextChars",
							"settings.ai.monthlyBudgetUsd", "settings.ai.excludedPaths[0]", "settings.ai.enabled");
			});
	}

	@Test
	void aiSettingsAreSavedAndAPageWithoutThemKeepsThem() throws Exception {
		service().load();
		ObjectNode tree = body(Settings.defaults());
		ObjectNode ai = (ObjectNode) tree.get("ai");
		ai.put("enabled", true);
		ai.put("model", "claude-opus-5-5");
		ai.put("monthlyBudgetUsd", 12.5);
		service().update(tree, service().get().version(), TestVault.ALICE, "client-a1");
		assertThat(service().current().ai())
			.isEqualTo(new AiSettings(true, "claude-code", "claude-opus-5-5", List.of("Private"), 60_000, 12.5));
		JsonNode onDisk = TestVault.JSON.readTree(Files.readString(this.file));
		assertThat(onDisk.get("ai").get("model").asString()).isEqualTo("claude-opus-5-5");
		// An old page sends no "ai": the feature stays as it was rather than falling back to "off".
		ObjectNode old = defaultsWith("files", "useWikilinks", false);
		old.remove("ai");
		service().update(old, service().get().version(), TestVault.BOB, "client-b1");
		assertThat(service().current().ai().enabled()).isTrue();
		assertThat(service().current().files().useWikilinks()).isFalse();
	}

	@Test
	void aiExcludedPathsMatchFoldersAndFiles() {
		AiSettings ai = new AiSettings(true, "claude-code", "claude-sonnet-5-5", List.of("Private/", "Health.md"), 60_000, 5);
		assertThat(ai.isExcluded("private/diary.md")).isTrue();
		assertThat(ai.isExcluded("Private")).isTrue();
		assertThat(ai.isExcluded("health.md")).isTrue();
		assertThat(ai.isExcluded("Privateer.md")).isFalse();
		assertThat(ai.isExcluded("Notes/Private/x.md")).isFalse();
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
