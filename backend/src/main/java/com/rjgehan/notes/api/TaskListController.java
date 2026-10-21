package com.rjgehan.notes.api;

import java.io.IOException;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.dto.CreateTaskListRequest;
import com.rjgehan.notes.api.dto.ReorderRequest;
import com.rjgehan.notes.api.dto.SectionRequest;
import com.rjgehan.notes.api.dto.TaskListWriteResult;
import com.rjgehan.notes.api.dto.TaskListsResponse;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.tasks.TaskListService;
import org.jspecify.annotations.Nullable;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Task lists and sections (API.md §20.3). Mutating endpoints accept an {@code Idempotency-Key}. */
@RestController
public class TaskListController {

	private final TaskListService lists;

	private final IdempotencyCache idempotency;

	public TaskListController(TaskListService lists, IdempotencyCache idempotency) {
		this.lists = lists;
		this.idempotency = idempotency;
	}

	@GetMapping("/api/tasks/lists")
	TaskListsResponse lists() {
		return this.lists.lists();
	}

	@PostMapping("/api/tasks/lists")
	ResponseEntity<TaskListWriteResult> create(
			@RequestBody(required = false) @Nullable CreateTaskListRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.status(HttpStatus.CREATED).body(this.lists.create(request, identity, origin)));
	}

	@PatchMapping("/api/tasks/lists/{id}")
	ResponseEntity<TaskListWriteResult> update(@PathVariable String id,
			@RequestBody(required = false) @Nullable UpdateTaskRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.update(id, request, identity, origin)));
	}

	@DeleteMapping("/api/tasks/lists/{id}")
	ResponseEntity<TaskListWriteResult> delete(@PathVariable String id, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.delete(id, identity, origin)));
	}

	@PostMapping("/api/tasks/lists/reorder")
	ResponseEntity<TaskListWriteResult> reorder(@RequestBody(required = false) @Nullable ReorderRequest request,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.reorder(request, identity, origin)));
	}

	@PostMapping("/api/tasks/lists/{id}/sections")
	ResponseEntity<TaskListWriteResult> createSection(@PathVariable String id,
			@RequestBody(required = false) @Nullable SectionRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http, () -> ResponseEntity.status(HttpStatus.CREATED)
			.body(this.lists.createSection(id, request, identity, origin)));
	}

	@PatchMapping("/api/tasks/lists/{id}/sections/{sectionId}")
	ResponseEntity<TaskListWriteResult> renameSection(@PathVariable String id, @PathVariable String sectionId,
			@RequestBody(required = false) @Nullable SectionRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.renameSection(id, sectionId, request, identity, origin)));
	}

	@DeleteMapping("/api/tasks/lists/{id}/sections/{sectionId}")
	ResponseEntity<TaskListWriteResult> deleteSection(@PathVariable String id, @PathVariable String sectionId,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.deleteSection(id, sectionId, identity, origin)));
	}

	@PostMapping("/api/tasks/lists/{id}/sections/reorder")
	ResponseEntity<TaskListWriteResult> reorderSections(@PathVariable String id,
			@RequestBody(required = false) @Nullable ReorderRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.lists.reorderSections(id, request, identity, origin)));
	}

}
