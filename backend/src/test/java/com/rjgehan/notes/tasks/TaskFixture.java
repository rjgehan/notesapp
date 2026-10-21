package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.api.dto.CreateTaskListRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskWriteResult;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.events.VaultEvent;
import com.rjgehan.notes.support.TestVault;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** The task services over a {@link TestVault}, wired as Spring wires them. */
final class TaskFixture implements AutoCloseable {

	static final String CLIENT = "client-tasks-1";

	final TestVault vault;

	final TaskStore store;

	final TaskWrites writes;

	final TaskListService lists;

	final TaskService tasks;

	final TaskArchiver archiver;

	private TaskFixture(TestVault vault) {
		this.vault = vault;
		this.store = new TaskStore(vault.index, vault.fs, vault.kinds, TestVault.JSON);
		this.writes = new TaskWrites(vault.paths, vault.fs, vault.locks, vault.index, vault.files, vault.kinds,
				vault.reconciler, vault.batcher, vault.hub, this.store, vault.clock);
		this.lists = new TaskListService(this.store, this.writes, vault.nameRules, vault.moves, vault.trash,
				vault.index);
		this.tasks = new TaskService(this.store, this.writes, this.lists);
		this.archiver = new TaskArchiver(this.store, this.writes, vault.nameRules, vault.properties);
	}

	static TaskFixture start(Path dir) throws IOException {
		return new TaskFixture(TestVault.start(dir));
	}

	static TaskFixture start(Path dir, Map<String, String> overrides) throws IOException {
		return new TaskFixture(TestVault.start(dir, overrides));
	}

	static ObjectNode json(String text) {
		return (ObjectNode) TestVault.JSON.readTree(text);
	}

	TaskList createList(String name) throws IOException {
		return this.lists.create(new CreateTaskListRequest(name, null, null),
				TestVault.ALICE, CLIENT).lists().get(0);
	}

	Task create(String body) throws IOException {
		TaskWriteResult result = this.tasks.create(json(body), TestVault.ALICE, CLIENT);
		return result.task();
	}

	TaskWriteResult patch(String id, String changes, String base) throws IOException {
		JsonNode baseNode = (base != null) ? json(base) : null;
		return this.tasks.update(id, new UpdateTaskRequest(json(changes), baseNode),
				TestVault.ALICE, CLIENT);
	}

	Task get(String id) {
		return this.tasks.get(id);
	}

	String read(String path) throws IOException {
		return Files.readString(this.vault.root.resolve(path), StandardCharsets.UTF_8);
	}

	void write(String path, String content) throws IOException {
		Path file = this.vault.root.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, content, StandardCharsets.UTF_8);
	}

	/** The names of the events published since {@code mark}. */
	List<String> eventsSince(int mark) {
		return this.vault.hub.published.subList(mark, this.vault.hub.published.size())
			.stream()
			.map(VaultEvent::eventName)
			.toList();
	}

	int mark() {
		return this.vault.hub.published.size();
	}

	@Override
	public void close() {
		this.vault.close();
	}

}
