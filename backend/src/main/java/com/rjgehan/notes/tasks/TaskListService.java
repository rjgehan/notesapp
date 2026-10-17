package com.rjgehan.notes.tasks;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.api.dto.CreateTaskListRequest;
import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.api.dto.MovedFile;
import com.rjgehan.notes.api.dto.ReorderRequest;
import com.rjgehan.notes.api.dto.SectionRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskList;
import com.rjgehan.notes.api.dto.TaskListWriteResult;
import com.rjgehan.notes.api.dto.TaskListsResponse;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.events.ListChangedEvent;
import com.rjgehan.notes.events.TaskEvent;
import com.rjgehan.notes.history.Author;
import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.index.FileRecord;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.tasks.TaskCodec.ListField;
import com.rjgehan.notes.vault.ApiPath;
import com.rjgehan.notes.vault.MoveService;
import com.rjgehan.notes.vault.NameRules;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.TrashService;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * Task lists and their sections (API.md §20.3). A list is a file: creating one creates {@code Tasks/<Name>.tasks},
 * renaming it renames the file too (through {@link MoveService}, so links to it are updated), and deleting it moves
 * the file to the trash. Sections live in the list's file, with fractional-index order keys like tasks.
 */
@Service
public class TaskListService {

	private static final Logger logger = LoggerFactory.getLogger(TaskListService.class);

	/** The folder new lists are created in. */
	static final String FOLDER = "Tasks";

	private static final int ATTEMPTS = 5;

	private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

	private final TaskStore store;

	private final TaskWrites writes;

	private final NameRules nameRules;

	private final MoveService moves;

	private final TrashService trash;

	private final VaultIndex index;

	public TaskListService(TaskStore store, TaskWrites writes, NameRules nameRules, MoveService moves,
			TrashService trash, VaultIndex index) {
		this.store = store;
		this.writes = writes;
		this.nameRules = nameRules;
		this.moves = moves;
		this.trash = trash;
		this.index = index;
	}

	/** An edit of one list file under its lock; returns false when it changes nothing. */
	@FunctionalInterface
	private interface Edit {

		boolean apply(TaskFile file, TaskWrites.Session session, ApiPath path) throws IOException;

	}

	public TaskListsResponse lists() {
		TaskCatalog catalog = this.store.catalog();
		return new TaskListsResponse(catalog.lists(), catalog.problems());
	}

	// ---------------------------------------------------------------- create

	/** {@code POST /api/tasks/lists}: a new list, last in the list order, in {@code Tasks/<Name>.tasks}. */
	public TaskListWriteResult create(@Nullable CreateTaskListRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		String name = TaskCodec.name((request != null) ? request.name() : null, "name", errors);
		ObjectNode extras = NODES.objectNode();
		if (request != null && request.color() != null) {
			extras.put("color", request.color());
		}
		if (request != null && request.icon() != null) {
			extras.put("icon", request.icon());
		}
		Map<ListField, JsonNode> fields = TaskCodec.listFields(extras, "list", errors);
		TaskService.requireValid(errors);
		TaskCatalog catalog = this.store.catalog();
		String order = TaskOrder.after(catalog.lists().stream().map(TaskList::order).toList());
		return createFile(name, order, fields, true, identity, origin);
	}

	/**
	 * Makes sure the Inbox ({@code Tasks/Inbox.tasks}, first in the list order) exists, for a task created without a
	 * list. Two devices creating it at once is fine: the second create finds the file there.
	 */
	void ensureInbox(Identity identity, @Nullable String origin) throws IOException {
		TaskCatalog catalog = this.store.catalog();
		if (catalog.listAt(TaskService.INBOX) != null) {
			return;
		}
		List<String> orders = catalog.lists().stream().map(TaskList::order).toList();
		String first = orders.stream().filter(FractionalIndex::isValid).sorted().findFirst().orElse(null);
		List<String> keys = TaskOrder.keysBetween(null, first, 1);
		String order = (keys != null) ? keys.get(0) : TaskOrder.after(orders);
		try {
			createFile("Inbox", order, Map.of(), false, identity, origin);
		}
		catch (NotesException ex) {
			if (ex.code() != ErrorCode.ALREADY_EXISTS && ex.code() != ErrorCode.CASE_COLLISION) {
				throw ex;
			}
		}
	}

	/** Creates the file of a new list; with {@code rename}, a taken file name gets " 1", " 2", ... */
	private TaskListWriteResult createFile(String name, String order, Map<ListField, JsonNode> fields,
			boolean rename, Identity identity, @Nullable String origin) throws IOException {
		Author author = Author.of(identity);
		String fileName = fileName(name);
		String id = this.writes.newId();
		for (int n = 0; n <= NameRules.MAX_SUFFIX; n++) {
			ApiPath path = this.writes.fresh(FOLDER + "/" + ((n == 0) ? fileName : NameRules.withSuffix(fileName, n)));
			if (rename && this.writes.isTaken(path)) {
				continue;
			}
			ObjectNode list = NODES.objectNode();
			list.put("id", id);
			list.put("name", name);
			fields.forEach((field, value) -> {
				if (!value.isNull()) {
					list.set(field.json, value);
				}
			});
			list.put("order", order);
			list.put("archived", false);
			TaskFile file = TaskFile.newList(list);
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				session.create(path, file);
				TaskList created = TaskCodec.readList(file.list(), path.nfc(), true, new ArrayList<>());
				session.publish(new ListChangedEvent(id, created, origin));
				TaskWrites.Committed committed = session.commit();
				logger.info("TASKLIST create {} client={} user={}", path.nfc(), origin, identity.login());
				return new TaskListWriteResult(List.of(created), committed.files(), committed.createdFolders(), null,
						null);
			}
			catch (NotesException ex) {
				boolean taken = ex.code() == ErrorCode.ALREADY_EXISTS || ex.code() == ErrorCode.CASE_COLLISION;
				if (!rename || !taken) {
					throw ex;
				}
			}
		}
		throw NotesException.alreadyExists(FOLDER + "/" + fileName, FOLDER + "/" + fileName);
	}

	/** The file name for a list name: the name made into a valid new file name, plus {@code .tasks}. */
	String fileName(String name) {
		String sanitized = this.nameRules.sanitizeAttachmentName(name.replace('/', '-').replace('\\', '-') + ".tasks");
		return sanitized.endsWith(".tasks") && sanitized.length() > ".tasks".length() ? sanitized : "List.tasks";
	}

	// ---------------------------------------------------------------- update

	/**
	 * {@code PATCH /api/tasks/lists/{id}}: name, color, icon and archived, with the same {@code base} conflict check
	 * as tasks. A new name also renames the list's file (in its folder), and links to the file follow.
	 */
	public TaskListWriteResult update(String id, @Nullable UpdateTaskRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		JsonNode changes = (request != null) ? request.changes() : null;
		JsonNode base = (request != null) ? request.base() : null;
		List<FieldError> errors = new ArrayList<>();
		if (changes == null || !changes.isObject()) {
			errors.add(new FieldError("changes", "must be an object"));
		}
		TaskService.requireValid(errors);
		Map<ListField, JsonNode> fields = TaskCodec.listFields(changes, "changes", errors);
		TaskService.requireValid(errors);
		TaskList seen = this.store.catalog().requireList(id);
		checkBase(seen, fields, base);
		// One operation, so the commits of a rename are announced after the list's own events.
		try (CommitBatcher.Operation operation = this.writes.operation()) {
			return update(seen, fields, base, identity, origin);
		}
	}

	private TaskListWriteResult update(TaskList seen, Map<ListField, JsonNode> fields, @Nullable JsonNode base,
			Identity identity, @Nullable String origin) throws IOException {
		MovedFile moved = null;
		JsonNode name = fields.get(ListField.NAME);
		if (name != null && !name.stringValue().equals(seen.name())) {
			moved = renameFile(seen, name.stringValue(), identity, origin);
		}
		TaskListWriteResult result = edit(seen.id(), identity, origin, (file, session, path) -> {
			TaskList current = TaskCodec.readList(file.list(), path.nfc(), true, new ArrayList<>());
			checkBase(current, fields, base);
			boolean changed = false;
			for (Map.Entry<ListField, JsonNode> entry : fields.entrySet()) {
				if (TaskCodec.same(entry.getValue(), TaskCodec.apiValue(current, entry.getKey()))) {
					continue;
				}
				if (entry.getValue().isNull()) {
					file.list().remove(entry.getKey().json);
				}
				else {
					file.list().set(entry.getKey().json, entry.getValue());
				}
				changed = true;
			}
			return changed;
		});
		if (moved == null) {
			return result;
		}
		List<FileEntry> files = result.files();
		if (files.isEmpty()) {
			FileRecord record = this.index.file(moved.to());
			files = (record != null) ? List.of(record.toEntry()) : List.of();
		}
		return new TaskListWriteResult(result.lists(), files, result.createdFolders(), moved, null);
	}

	/**
	 * Renames a list's file for its new name, with " 1", " 2", ... when that name is taken. Returns the move, or null
	 * when the file name does not change. Runs before the name is written, without any lock held (the move takes the
	 * vault write lock itself).
	 */
	private @Nullable MovedFile renameFile(TaskList list, String name, Identity identity, @Nullable String origin)
			throws IOException {
		String folder = PathNames.parentOf(list.path());
		String fileName = fileName(name);
		for (int n = 0; n <= NameRules.MAX_SUFFIX; n++) {
			String candidate = PathNames.join(folder, (n == 0) ? fileName : NameRules.withSuffix(fileName, n));
			if (candidate.equals(list.path())) {
				return null;
			}
			boolean caseOnly = PathNames.lower(candidate).equals(PathNames.lower(list.path()));
			if (!caseOnly && this.writes.isTaken(this.writes.fresh(candidate))) {
				continue;
			}
			try {
				MoveResult result = this.moves.move(list.path(), candidate, null, false, identity, origin);
				logger.info("TASKLIST rename {} → {} client={}", list.path(), result.to(), origin);
				return new MovedFile(result.from(), result.to());
			}
			catch (NotesException ex) {
				if (ex.code() != ErrorCode.ALREADY_EXISTS && ex.code() != ErrorCode.CASE_COLLISION) {
					throw ex;
				}
			}
		}
		return null;
	}

	// ---------------------------------------------------------------- delete and reorder

	/**
	 * {@code DELETE /api/tasks/lists/{id}}: moves the list's file to the trash (restorable like any file). Its archive
	 * files stay where they are.
	 */
	public TaskListWriteResult delete(String id, Identity identity, @Nullable String origin) throws IOException {
		TaskCatalog catalog = this.store.catalog();
		TaskList list = catalog.requireList(id);
		TrashEntry entry;
		try (CommitBatcher.Operation operation = this.writes.operation()) {
			entry = this.trash.deleteFile(list.path(), identity, origin);
			this.writes.hub().publish(new ListChangedEvent(id, null, origin));
		}
		return new TaskListWriteResult(List.of(), List.of(), List.of(), null, entry);
	}

	/** {@code POST /api/tasks/lists/reorder}: like task reordering, over the lists' {@code order}. */
	public TaskListWriteResult reorder(@Nullable ReorderRequest request, Identity identity, @Nullable String origin)
			throws IOException {
		Set<String> ids = ids(request);
		Author author = Author.of(identity);
		for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
			TaskCatalog catalog = this.store.catalog();
			List<TaskList> moving = new ArrayList<>();
			for (String id : ids) {
				moving.add(catalog.requireList(id));
			}
			List<TaskList> siblings = new ArrayList<>(catalog.lists());
			siblings.removeIf((list) -> ids.contains(list.id()));
			Map<String, String> keys = keys(siblings.stream().map(TaskList::id).toList(),
					siblings.stream().map(TaskList::order).toList(), List.copyOf(ids), request.after());
			List<ApiPath> paths = new ArrayList<>();
			Map<String, ApiPath> byId = new LinkedHashMap<>();
			for (String listId : keys.keySet()) {
				TaskList list = catalog.requireList(listId);
				ApiPath path = writablePath(catalog, list.path());
				paths.add(path);
				byId.put(listId, path);
			}
			try (TaskWrites.Session session = this.writes.open(paths, author, origin)) {
				List<TaskList> changed = new ArrayList<>();
				boolean stale = false;
				for (Map.Entry<String, ApiPath> entry : byId.entrySet()) {
					TaskFile file = session.require(entry.getValue());
					if (file.isArchive() || !file.listId().equals(entry.getKey())) {
						stale = true;
						break;
					}
					String key = keys.get(entry.getKey());
					if (!key.equals(file.list().path("order").stringValue(""))) {
						file.list().put("order", key);
						session.touch(file);
						TaskList list = TaskCodec.readList(file.list(), entry.getValue().nfc(), true,
								new ArrayList<>());
						changed.add(list);
						session.publish(new ListChangedEvent(list.id(), list, origin));
					}
				}
				if (stale) {
					continue;
				}
				TaskWrites.Committed committed = session.commit();
				return new TaskListWriteResult(List.copyOf(changed), committed.files(), committed.createdFolders(),
						null, null);
			}
		}
		throw NotesException.busy();
	}

	// ---------------------------------------------------------------- sections

	/** {@code POST /api/tasks/lists/{id}/sections}: a new section, last. */
	public TaskListWriteResult createSection(String listId, @Nullable SectionRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		String name = TaskCodec.name((request != null) ? request.name() : null, "name", errors);
		TaskService.requireValid(errors);
		return edit(listId, identity, origin, (file, session, path) -> {
			ArrayNode sections = sections(file);
			if (sections.size() >= TaskCodec.MAX_SECTIONS) {
				throw NotesException.badRequest("A list can have at most " + TaskCodec.MAX_SECTIONS + " sections");
			}
			List<String> orders = new ArrayList<>();
			sections.forEach((section) -> orders.add(section.path("order").stringValue("")));
			ObjectNode section = sections.addObject();
			section.put("id", this.writes.newId());
			section.put("name", name);
			section.put("order", TaskOrder.after(orders));
			return true;
		});
	}

	/** {@code PATCH /api/tasks/lists/{id}/sections/{sectionId}}: renames a section. */
	public TaskListWriteResult renameSection(String listId, String sectionId, @Nullable SectionRequest request,
			Identity identity, @Nullable String origin) throws IOException {
		List<FieldError> errors = new ArrayList<>();
		String name = TaskCodec.name((request != null) ? request.name() : null, "name", errors);
		TaskService.requireValid(errors);
		return edit(listId, identity, origin, (file, session, path) -> {
			ObjectNode section = section(file, sectionId);
			if (name.equals(section.path("name").stringValue(null))) {
				return false;
			}
			section.put("name", name);
			return true;
		});
	}

	/** {@code DELETE /api/tasks/lists/{id}/sections/{sectionId}}: its tasks stay, without a section. */
	public TaskListWriteResult deleteSection(String listId, String sectionId, Identity identity,
			@Nullable String origin) throws IOException {
		return edit(listId, identity, origin, (file, session, path) -> {
			ArrayNode sections = sections(file);
			boolean removed = false;
			for (int i = 0; i < sections.size(); i++) {
				if (sectionId.equals(sections.get(i).path("id").stringValue(null))) {
					sections.remove(i);
					removed = true;
					break;
				}
			}
			if (!removed) {
				throw new NotesException(ErrorCode.NOT_FOUND, "No such section: " + sectionId);
			}
			String now = this.writes.now().toString();
			for (ObjectNode node : file.tasks()) {
				if (sectionId.equals(TaskTree.section(node))) {
					node.remove("sectionId");
					node.put("updatedAt", now);
					Task task = TaskCodec.readTask(node, file.listId(), false).task();
					if (task != null) {
						session.publish(TaskEvent.changed(task, origin));
					}
				}
			}
			return true;
		});
	}

	/** {@code POST /api/tasks/lists/{id}/sections/reorder}. */
	public TaskListWriteResult reorderSections(String listId, @Nullable ReorderRequest request, Identity identity,
			@Nullable String origin) throws IOException {
		Set<String> ids = ids(request);
		return edit(listId, identity, origin, (file, session, path) -> {
			ArrayNode sections = sections(file);
			List<String> siblingIds = new ArrayList<>();
			List<String> siblingOrders = new ArrayList<>();
			List<ObjectNode> sorted = new ArrayList<>();
			sections.forEach((section) -> {
				if (section instanceof ObjectNode object) {
					sorted.add(object);
				}
			});
			sorted.sort(TaskTree.ORDER);
			for (ObjectNode section : sorted) {
				String id = TaskTree.id(section);
				if (!ids.contains(id)) {
					siblingIds.add(id);
					siblingOrders.add(TaskTree.order(section));
				}
			}
			for (String id : ids) {
				section(file, id);
			}
			Map<String, String> keys = keys(siblingIds, siblingOrders, List.copyOf(ids), request.after());
			boolean changed = false;
			for (Map.Entry<String, String> entry : keys.entrySet()) {
				ObjectNode section = section(file, entry.getKey());
				if (!entry.getValue().equals(section.path("order").stringValue(""))) {
					section.put("order", entry.getValue());
					changed = true;
				}
			}
			return changed;
		});
	}

	// ---------------------------------------------------------------- helpers

	private TaskListWriteResult edit(String id, Identity identity, @Nullable String origin, Edit edit)
			throws IOException {
		Author author = Author.of(identity);
		for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
			TaskCatalog catalog = this.store.catalog();
			TaskList list = catalog.requireList(id);
			ApiPath path = writablePath(catalog, list.path());
			try (TaskWrites.Session session = this.writes.open(List.of(path), author, origin)) {
				TaskFile file = session.require(path);
				if (file.isArchive() || !file.listId().equals(id)) {
					continue;
				}
				boolean changed = edit.apply(file, session, path);
				TaskList after = TaskCodec.readList(file.list(), path.nfc(), true, new ArrayList<>());
				if (!changed) {
					return new TaskListWriteResult(List.of(after), List.of(), List.of(), null, null);
				}
				session.touch(file);
				session.publish(new ListChangedEvent(id, after, origin));
				TaskWrites.Committed committed = session.commit();
				logger.debug("TASKLIST update {} client={}", path.nfc(), origin);
				return new TaskListWriteResult(List.of(after), committed.files(), committed.createdFolders(), null,
						null);
			}
		}
		throw NotesException.busy();
	}

	private ApiPath writablePath(TaskCatalog catalog, String path) {
		String blocked = catalog.blocked(path);
		if (blocked != null) {
			throw TaskWrites.malformed(path, blocked);
		}
		return this.writes.existing(path);
	}

	private static ArrayNode sections(TaskFile file) {
		JsonNode sections = file.list().get("sections");
		if (sections instanceof ArrayNode array) {
			return array;
		}
		if (sections != null && !sections.isNull()) {
			throw TaskWrites.malformed("list " + file.listId(), "\"list.sections\" is not an array");
		}
		return file.list().putArray("sections");
	}

	private static ObjectNode section(TaskFile file, String sectionId) {
		for (JsonNode section : sections(file)) {
			if (section instanceof ObjectNode object && sectionId.equals(object.path("id").stringValue(null))) {
				return object;
			}
		}
		throw new NotesException(ErrorCode.NOT_FOUND, "No such section: " + sectionId);
	}

	private static Set<String> ids(@Nullable ReorderRequest request) {
		if (request == null || request.ids() == null || request.ids().isEmpty()) {
			throw NotesException.badRequest("ids must be a non-empty array");
		}
		Set<String> ids = new LinkedHashSet<>();
		for (String id : request.ids()) {
			if (id == null || !TaskFile.ID.matcher(id).matches() || !ids.add(id)) {
				throw TaskService.invalid("ids", "must be distinct ids");
			}
		}
		if (request.after() != null && ids.contains(request.after())) {
			throw TaskService.invalid("after", "cannot be one of the moved items");
		}
		return ids;
	}

	/**
	 * Order keys for {@code moving}, placed right after {@code after} among the sorted siblings: only the moved items
	 * when the neighbours allow it, otherwise fresh keys for the whole sequence.
	 */
	private static Map<String, String> keys(List<String> siblingIds, List<String> siblingOrders, List<String> moving,
			@Nullable String after) {
		int index = 0;
		if (after != null) {
			index = siblingIds.indexOf(after) + 1;
			if (index == 0) {
				throw TaskService.invalid("after", "is not one of the other items");
			}
		}
		String previous = (index > 0) ? siblingOrders.get(index - 1) : null;
		String next = (index < siblingOrders.size()) ? siblingOrders.get(index) : null;
		Map<String, String> keys = new LinkedHashMap<>();
		List<String> between = TaskOrder.keysBetween(previous, next, moving.size());
		if (between != null) {
			for (int i = 0; i < moving.size(); i++) {
				keys.put(moving.get(i), between.get(i));
			}
			return keys;
		}
		List<String> sequence = new ArrayList<>(siblingIds.subList(0, index));
		sequence.addAll(moving);
		sequence.addAll(siblingIds.subList(index, siblingIds.size()));
		List<String> fresh = TaskOrder.renumber(sequence.size());
		for (int i = 0; i < sequence.size(); i++) {
			keys.put(sequence.get(i), fresh.get(i));
		}
		return keys;
	}

	private static void checkBase(TaskList current, Map<ListField, JsonNode> fields, @Nullable JsonNode base) {
		if (base == null || !base.isObject()) {
			return;
		}
		List<String> conflicting = new ArrayList<>();
		fields.forEach((field, value) -> {
			JsonNode seen = base.get(field.json);
			JsonNode now = TaskCodec.apiValue(current, field);
			if (seen != null && !TaskCodec.same(seen, now) && !TaskCodec.same(value, now)) {
				conflicting.add(field.json);
			}
		});
		if (!conflicting.isEmpty()) {
			throw new NotesException(ErrorCode.TASK_CONFLICT,
					"The list changed on the server: " + String.join(", ", conflicting),
					Map.of("list", current, "fields", conflicting));
		}
	}

}
