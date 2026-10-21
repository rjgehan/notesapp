package com.rjgehan.notes.tasks;

import java.nio.charset.StandardCharsets;

import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskStatus;
import com.rjgehan.notes.config.JsonConfig;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.vault.TextCodec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The {@code .tasks} file format: what is malformed, what survives a write, and the canonical form. */
class TaskFileTest {

	private static final ObjectWriter WRITER = JsonConfig.vaultFileWriter(TestVault.JSON);

	static final String HOME = """
			{
			  "type": "notesapp-tasks",
			  "version": 1,
			  "list": { "id": "01JLIST000000000000000HOME", "name": "Home", "order": "a0", "archived": false,
			            "x-theme": "blue" },
			  "tasks": [
			    { "id": "01JTASK0000000000000000002", "title": "Water plants", "x-custom": [1, 2] },
			    { "listId": "stale", "title": "Pay rent", "id": "01JTASK0000000000000000001", "due": "2026-11-01",
			      "priority": 2, "status": "open", "tags": ["bills"], "links": [], "order": "a0",
			      "createdAt": "2026-10-01T10:00:00.000Z", "updatedAt": "2026-10-01T10:00:00.000Z" }
			  ]
			}
			""";

	@Test
	void theCanonicalFormSortsTasksAndKeysAndKeepsUnknownFields() throws Exception {
		TaskFile file = TaskFile.parse(HOME.getBytes(StandardCharsets.UTF_8), TestVault.JSON);
		String written = new String(file.serialize(WRITER), StandardCharsets.UTF_8);
		assertThat(written).isEqualTo("""
				{
				  "type": "notesapp-tasks",
				  "version": 1,
				  "list": {
				    "id": "01JLIST000000000000000HOME",
				    "name": "Home",
				    "order": "a0",
				    "archived": false,
				    "x-theme": "blue"
				  },
				  "tasks": [
				    {
				      "id": "01JTASK0000000000000000001",
				      "title": "Pay rent",
				      "status": "open",
				      "priority": 2,
				      "due": "2026-11-01",
				      "tags": [
				        "bills"
				      ],
				      "links": [],
				      "order": "a0",
				      "createdAt": "2026-10-01T10:00:00.000Z",
				      "updatedAt": "2026-10-01T10:00:00.000Z"
				    },
				    {
				      "id": "01JTASK0000000000000000002",
				      "title": "Water plants",
				      "x-custom": [
				        1,
				        2
				      ]
				    }
				  ]
				}
				""");
		// Writing it again changes nothing.
		TaskFile again = TaskFile.parse(written.getBytes(StandardCharsets.UTF_8), TestVault.JSON);
		assertThat(new String(again.serialize(WRITER), StandardCharsets.UTF_8)).isEqualTo(written);
	}

	@Test
	void aByteOrderMarkIsKept() throws Exception {
		byte[] bytes = TextCodec.encode(HOME, true);
		TaskFile file = TaskFile.parse(bytes, TestVault.JSON);
		assertThat(TextCodec.hasBom(file.serialize(WRITER))).isTrue();
	}

	@ParameterizedTest
	@ValueSource(strings = { "", "not json", "[]", "{\"type\": \"other\"}",
			"{\"type\": \"notesapp-tasks\", \"version\": \"1\", \"list\": {\"id\": \"L1\", \"name\": \"A\"}}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1, \"list\": {\"id\": \"has space\", \"name\": \"A\"}}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1, \"list\": {\"id\": \"L1\", \"name\": \" \"}}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1, \"list\": {\"id\": \"L1\", \"name\": \"A\"}, \"tasks\": {}}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1, \"archive\": \"yes\", \"list\": {\"id\": \"L1\", \"name\": \"A\"}}",
			"{\"type\": \"notesapp-tasks\", \"version\": 1, \"list\": {\"id\": \"L1\", \"name\": \"A\"}} trailing text" })
	void malformedFilesAreRejected(String content) {
		assertThatThrownBy(() -> TaskFile.parse(content.getBytes(StandardCharsets.UTF_8), TestVault.JSON))
			.isInstanceOf(TaskFile.MalformedException.class);
	}

	@Test
	void invalidUtf8IsMalformed() {
		byte[] bytes = { '{', (byte) 0xff, '}' };
		assertThatThrownBy(() -> TaskFile.parse(bytes, TestVault.JSON)).isInstanceOf(TaskFile.MalformedException.class)
			.hasMessage("not valid UTF-8");
	}

	@Test
	void theParseErrorNamesAPositionButNoContent() {
		String content = "{\"type\": \"notesapp-tasks\",\n  secret";
		assertThatThrownBy(() -> TaskFile.parse(content.getBytes(StandardCharsets.UTF_8), TestVault.JSON))
			.hasMessageStartingWith("not valid JSON (line 2")
			.hasMessageNotContaining("secret");
	}

	@Test
	void aMinimalHandWrittenFileIsUsable() throws Exception {
		String content = """
				{"type": "notesapp-tasks", "version": 1, "list": {"id": "groceries", "name": "Groceries"},
				 "tasks": [{"id": "milk", "title": "Milk"}]}
				""";
		TaskSnapshot snapshot = TaskSnapshot.of("Tasks/Groceries.tasks", "v",
				TaskFile.parse(content.getBytes(StandardCharsets.UTF_8), TestVault.JSON));
		assertThat(snapshot.problems()).isEmpty();
		Task milk = snapshot.tasks().get(0);
		assertThat(milk.listId()).isEqualTo("groceries");
		assertThat(milk.status()).isEqualTo(TaskStatus.OPEN);
		assertThat(milk.priority()).isZero();
		assertThat(milk.tags()).isEmpty();
		assertThat(milk.createdAt()).isNull();
		assertThat(snapshot.list().order()).isEmpty();
	}

	@Test
	void unusableTasksAreReportedAndSkippedButKept() throws Exception {
		String content = """
				{"type": "notesapp-tasks", "version": 1, "list": {"id": "L", "name": "L"},
				 "tasks": [
				   {"id": "ok", "title": "Fine", "reminders": [{"at": "soon"}], "tags": ["a", 3]},
				   {"id": "bad-status", "title": "X", "status": "waiting"},
				   {"id": "bad-due", "title": "X", "due": "tomorrow"},
				   {"title": "No id"},
				   42
				 ]}
				""";
		TaskFile file = TaskFile.parse(content.getBytes(StandardCharsets.UTF_8), TestVault.JSON);
		TaskSnapshot snapshot = TaskSnapshot.of("Tasks/L.tasks", "v", file);
		assertThat(snapshot.tasks()).extracting(Task::id).containsExactly("ok");
		assertThat(snapshot.tasks().get(0).reminders()).isEmpty();
		assertThat(snapshot.tasks().get(0).tags()).containsExactly("a");
		assertThat(snapshot.problems()).extracting((p) -> p.taskId() + ": " + p.reason())
			.contains("ok: a reminder has no valid \"at\" (YYYY-MM-DDTHH:mm)",
					"bad-status: \"status\" must be open, done or cancelled",
					"bad-due: \"due\" and \"start\" must be YYYY-MM-DD or YYYY-MM-DDTHH:mm",
					"null: 1 task has no valid \"id\"", "null: 1 entries of \"tasks\" are not objects");
		// Nothing is dropped when the file is written back.
		String written = new String(file.serialize(WRITER), StandardCharsets.UTF_8);
		assertThat(written).contains("waiting", "tomorrow", "No id", "42", "soon");
	}

	@Test
	void aNewerFormatVersionIsReadOnly() throws Exception {
		String content = HOME.replace("\"version\": 1", "\"version\": 2");
		TaskSnapshot snapshot = TaskSnapshot.of("Tasks/Home.tasks", "v",
				TaskFile.parse(content.getBytes(StandardCharsets.UTF_8), TestVault.JSON));
		assertThat(snapshot.blocked()).contains("newer version");
		assertThat(snapshot.list().writable()).isFalse();
		assertThat(snapshot.tasks()).hasSize(2);
	}

	@Test
	void newFilesHaveTheirFrame() {
		ObjectNode list = TestVault.JSON.createObjectNode().put("id", "L").put("name", "Work");
		TaskFile file = TaskFile.newList(list);
		assertThat(file.isArchive()).isFalse();
		assertThat(file.tasks()).isEmpty();
		TaskFile archive = TaskFile.newArchive("L", "Work");
		assertThat(archive.isArchive()).isTrue();
		assertThat(archive.listId()).isEqualTo("L");
		assertThat(new String(archive.serialize(WRITER), StandardCharsets.UTF_8))
			.startsWith("{\n  \"type\": \"notesapp-tasks\",\n  \"version\": 1,\n  \"archive\": true,");
	}

}
