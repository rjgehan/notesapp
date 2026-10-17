package com.rjgehan.notes.api;

import java.io.IOException;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.ReorderTasksRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskWriteResult;
import com.rjgehan.notes.api.dto.TasksResponse;
import com.rjgehan.notes.api.dto.UpdateTaskRequest;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.tasks.TaskService;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Tasks (API.md §20.1, §20.2). Every mutating endpoint accepts an {@code Idempotency-Key}, so a retry after a lost
 * response is answered with the first response and nothing is done twice.
 */
@RestController
public class TaskController {

	private final TaskService tasks;

	private final IdempotencyCache idempotency;

	public TaskController(TaskService tasks, IdempotencyCache idempotency) {
		this.tasks = tasks;
		this.idempotency = idempotency;
	}

	@GetMapping("/api/tasks")
	TasksResponse query(@RequestParam(required = false) @Nullable String view,
			@RequestParam(required = false) @Nullable String list, @RequestParam(required = false) @Nullable String tag,
			@RequestParam(required = false) @Nullable String priority,
			@RequestParam(required = false) @Nullable String status, @RequestParam(required = false) @Nullable String q,
			@RequestParam(required = false) @Nullable String date, @RequestParam(required = false) @Nullable String tz,
			@RequestParam(required = false) @Nullable Integer days,
			@RequestParam(required = false) @Nullable Integer limit,
			@RequestParam(required = false) @Nullable String before) {
		return this.tasks.query(view, list, tag, priority, status, q, date, tz, days, limit, before);
	}

	@GetMapping("/api/tasks/{id}")
	Task get(@PathVariable String id) {
		return this.tasks.get(id);
	}

	@PostMapping("/api/tasks")
	ResponseEntity<TaskWriteResult> create(@RequestBody(required = false) @Nullable JsonNode body, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.status(HttpStatus.CREATED).body(this.tasks.create(body, identity, origin)));
	}

	@PatchMapping("/api/tasks/{id}")
	ResponseEntity<TaskWriteResult> update(@PathVariable String id,
			@RequestBody(required = false) @Nullable UpdateTaskRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.tasks.update(id, request, identity, origin)));
	}

	@PostMapping("/api/tasks/{id}/complete")
	ResponseEntity<TaskWriteResult> complete(@PathVariable String id,
			@RequestBody(required = false) @Nullable CompleteTaskRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.tasks.complete(id, request, identity, origin)));
	}

	@PostMapping("/api/tasks/{id}/uncomplete")
	ResponseEntity<TaskWriteResult> uncomplete(@PathVariable String id, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.tasks.uncomplete(id, identity, origin)));
	}

	@PostMapping("/api/tasks/reorder")
	ResponseEntity<TaskWriteResult> reorder(@RequestBody(required = false) @Nullable ReorderTasksRequest request,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.tasks.reorder(request, identity, origin)));
	}

	@DeleteMapping("/api/tasks/{id}")
	ResponseEntity<TaskWriteResult> delete(@PathVariable String id, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin,
			@RequestHeader(name = IdempotencyCache.HEADER, required = false) @Nullable String idempotencyKey,
			HttpServletRequest http) throws IOException {
		return this.idempotency.execute(idempotencyKey, http,
				() -> ResponseEntity.ok(this.tasks.delete(id, identity, origin)));
	}

}
