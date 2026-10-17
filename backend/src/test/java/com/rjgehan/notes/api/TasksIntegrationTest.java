package com.rjgehan.notes.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import com.rjgehan.notes.support.SseRecorder;
import com.rjgehan.notes.watch.VaultReconciler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/** The task API over HTTP (API.md §20): shapes, errors, CSRF, idempotency and events. */
@NotesIntegrationTest
class TasksIntegrationTest {

	private static final List<String> TASK_FIELDS = List.of("id", "listId", "sectionId", "parentId", "title", "notes",
			"status", "priority", "due", "start", "recurrence", "reminders", "tags", "links", "order", "createdAt",
			"updatedAt", "completedAt", "archived");

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
	}

	@LocalServerPort
	int port;

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	@Autowired
	VaultReconciler reconciler;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	private JsonNode createList(String name) {
		return this.api.postJson("/api/tasks/lists", Map.of("name", name)).ok(201).get("lists").get(0);
	}

	private JsonNode createTask(Object body) {
		return this.api.postJson("/api/tasks", body).ok(201).get("task");
	}

	@Test
	void aTaskHasEveryFieldOfTheContract() {
		JsonNode list = createList("Contract");
		Reply reply = this.api.postJson("/api/tasks",
				Map.of("title", "Pay rent [[Landlord]] #bills", "listId", list.get("id").asString(), "due",
						"2026-11-01", "priority", 2));
		JsonNode result = reply.ok(201);
		assertThat(reply.header("Cache-Control")).isEqualTo("no-store");
		assertThat(result.propertyNames()).containsExactlyInAnyOrder("task", "changed", "deleted", "rolledForward",
				"files", "createdFolders");
		JsonNode task = result.get("task");
		assertThat(task.propertyNames()).containsExactlyInAnyOrderElementsOf(TASK_FIELDS);
		assertThat(task.get("sectionId").isNull()).isTrue();
		assertThat(task.get("completedAt").isNull()).isTrue();
		assertThat(task.get("status").asString()).isEqualTo("open");
		assertThat(task.get("createdAt").asString()).matches(".*T.*\\.\\d{3}Z");
		assertThat(result.get("files").get(0).get("path").asString()).isEqualTo("Tasks/Contract.tasks");
		JsonNode fetched = this.api.get("/api/tasks/" + task.get("id").asString()).ok(200);
		assertThat(fetched).isEqualTo(task);
		assertThat(this.api.get("/api/tasks/NOPE").problem(404)).isEqualTo("not-found");
		JsonNode lists = this.api.get("/api/tasks/lists").ok(200);
		JsonNode listJson = lists.get("lists").get(0);
		assertThat(listJson.propertyNames()).containsExactlyInAnyOrder("id", "name", "color", "icon", "order",
				"archived", "sections", "path", "writable");
		assertThat(lists.get("problems").isArray()).isTrue();
	}

	@Test
	void viewsTakeTheClientsDay() {
		JsonNode list = createList("Views");
		String listId = list.get("id").asString();
		createTask(Map.of("title", "Due", "listId", listId, "due", "2026-10-16"));
		assertThat(this.api.get("/api/tasks?view=today").problem(400)).isEqualTo("bad-request");
		JsonNode today = this.api.get("/api/tasks?view=today&date=2026-10-16&list=" + listId).ok(200);
		assertThat(today.get("view").asString()).isEqualTo("today");
		assertThat(today.get("tasks")).hasSize(1);
		assertThat(today.get("total").asInt()).isEqualTo(1);
		JsonNode zoned = this.api.get("/api/tasks?view=today&tz=" + Api.enc("Europe/Paris") + "&list=" + listId)
			.ok(200);
		assertThat(zoned.get("lists").isArray()).isTrue();
		assertThat(this.api.get("/api/tasks?view=nope").problem(400)).isEqualTo("bad-request");
	}

	@Test
	void writesNeedTheClientIdAndAreSameOrigin() {
		assertThat(this.api.postJson("/api/tasks", Map.of("title", "x"), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
		assertThat(this.api.postJson("/api/tasks", Map.of("title", "x"), "Origin", "https://evil.example")
			.problem(403)).isEqualTo("cross-origin");
		assertThat(this.api.patchJson("/api/tasks/X", Map.of("changes", Map.of()), "X-Client-Id", null).problem(403))
			.isEqualTo("client-id-required");
	}

	@Test
	void aRetriedCreateWithTheSameKeyCreatesOneTask() {
		JsonNode list = createList("Retries");
		String listId = list.get("id").asString();
		Map<String, Object> body = Map.of("title", "Once", "listId", listId);
		JsonNode first = this.api.postJson("/api/tasks", body, "Idempotency-Key", "retry-key-0001").ok(201);
		JsonNode second = this.api.postJson("/api/tasks", body, "Idempotency-Key", "retry-key-0001").ok(201);
		assertThat(second).isEqualTo(first);
		JsonNode all = this.api.get("/api/tasks?view=list&list=" + listId).ok(200);
		assertThat(all.get("tasks")).hasSize(1);
	}

	@Test
	void conflictsAndMalformedFilesAreProblems() throws Exception {
		JsonNode list = createList("Problems");
		JsonNode task = createTask(Map.of("title", "A", "listId", list.get("id").asString()));
		String id = task.get("id").asString();
		this.api.patchJson("/api/tasks/" + id, Map.of("changes", Map.of("title", "B"))).ok(200);
		Reply conflict = this.api.patchJson("/api/tasks/" + id,
				Map.of("changes", Map.of("title", "C"), "base", Map.of("title", "A")));
		assertThat(conflict.problem(409)).isEqualTo("task-conflict");
		assertThat(conflict.json().get("task").get("title").asString()).isEqualTo("B");
		assertThat(conflict.json().get("fields").get(0).asString()).isEqualTo("title");
		JsonNode invalid = this.api.patchJson("/api/tasks/" + id, Map.of("changes", Map.of("priority", 9))).json();
		assertThat(invalid.get("code").asString()).isEqualTo("bad-request");
		assertThat(invalid.get("errors").get(0).get("field").asString()).isEqualTo("changes.priority");

		Path file = vault.resolve("Tasks/Problems.tasks");
		String broken = Files.readString(file).replace("\"version\": 1", "\"version\": \"one\"");
		Files.writeString(file, broken);
		Reply refused = this.api.patchJson("/api/tasks/" + id, Map.of("changes", Map.of("title", "D")));
		assertThat(refused.problem(409)).isEqualTo("malformed-file");
		assertThat(refused.json().get("path").asString()).isEqualTo("Tasks/Problems.tasks");
		assertThat(refused.json().get("reason").asString()).contains("version");
		assertThat(Files.readString(file)).isEqualTo(broken);
		JsonNode view = this.api.get("/api/tasks?view=list").ok(200);
		assertThat(view.get("problems").toString()).contains("Tasks/Problems.tasks");
	}

	@Test
	void otherDevicesGetTheEventsAndTheTextApiSeesTheFile() {
		JsonNode list = createList("Live");
		String listId = list.get("id").asString();
		String head = this.api.get("/api/status").ok(200).get("eventId").asString();
		try (SseRecorder other = SseRecorder.open(this.port, "tasks-other-01", head);
				SseRecorder self = SseRecorder.open(this.port, Api.CLIENT_ID, head)) {
			JsonNode task = createTask(Map.of("title", "Shared", "listId", listId));
			String id = task.get("id").asString();
			this.api.postJson("/api/tasks/" + id + "/complete", Map.of("tz", "Europe/Paris")).ok(200);
			this.api.delete("/api/tasks/" + id).ok(200);
			assertThat(other.awaitEvent("task.deleted")).containsSubsequence("file.changed", "task.created",
					"file.changed", "task.changed", "file.changed", "task.deleted");
			JsonNode created = other.frames()
				.stream()
				.filter((frame) -> frame.event().equals("task.created"))
				.findFirst()
				.orElseThrow()
				.data();
			assertThat(created.get("task").get("id").asString()).isEqualTo(id);
			assertThat(created.get("origin").asString()).isEqualTo(Api.CLIENT_ID);
			this.api.postJson("/api/tasks/lists", Map.of("name", "Marker")).ok(201);
			self.awaitEvent("history.committed");
			assertThat(self.eventNames()).doesNotContain("task.created", "task.changed", "task.deleted");
		}
		JsonNode text = this.api.get("/api/files?path=" + Api.enc("Tasks/Live.tasks")).ok(200);
		assertThat(text.get("kind").asString()).isEqualTo("text");
		assertThat(text.get("content").asString()).contains("\"type\": \"notesapp-tasks\"");
	}

	@Test
	void listsAndSectionsOverHttp() {
		JsonNode list = createList("Garden");
		String listId = list.get("id").asString();
		JsonNode section = this.api.postJson("/api/tasks/lists/" + listId + "/sections", Map.of("name", "Beds"))
			.ok(201)
			.get("lists")
			.get(0)
			.get("sections")
			.get(0);
		String sectionId = section.get("id").asString();
		this.api.patchJson("/api/tasks/lists/" + listId + "/sections/" + sectionId, Map.of("name", "Raised beds"))
			.ok(200);
		JsonNode renamed = this.api
			.patchJson("/api/tasks/lists/" + listId, Map.of("changes", Map.of("name", "Allotment", "color", "#00aa00")))
			.ok(200);
		assertThat(renamed.get("lists").get(0).get("path").asString()).isEqualTo("Tasks/Allotment.tasks");
		assertThat(renamed.get("moved").get("from").asString()).isEqualTo("Tasks/Garden.tasks");
		this.api.postJson("/api/tasks/lists/reorder", Map.of("ids", List.of(listId))).ok(200);
		this.api.delete("/api/tasks/lists/" + listId + "/sections/" + sectionId).ok(200);
		JsonNode deleted = this.api.delete("/api/tasks/lists/" + listId).ok(200);
		assertThat(deleted.get("trash").get("originalPath").asString()).isEqualTo("Tasks/Allotment.tasks");
		assertThat(this.api.delete("/api/tasks/lists/" + listId).problem(404)).isEqualTo("not-found");
	}

	@Test
	void tasksFeedBacklinks() {
		this.api.postJson("/api/files", Map.of("path", "Landlord.md", "content", "# Landlord\n")).ok(201);
		JsonNode list = createList("Links");
		createTask(Map.of("title", "Call [[Landlord]]", "listId", list.get("id").asString()));
		JsonNode backlinks = this.api.get("/api/notes/backlinks?path=Landlord.md").ok(200);
		assertThat(backlinks.get("linked").toString()).contains("Tasks/Links.tasks");
	}

}
