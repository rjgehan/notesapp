package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.ChangesResponse;
import com.rjgehan.notes.api.dto.DeletedFilesResponse;
import com.rjgehan.notes.api.dto.TimelineResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.history.TimelineService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** The vault-wide history: timeline, changes over a period, deleted files (API.md §14.6–14.8). */
@RestController
public class TimelineController {

	private static final int MAX_LIMIT = 200;

	private final TimelineService timeline;

	public TimelineController(TimelineService timeline) {
		this.timeline = timeline;
	}

	@GetMapping("/api/history/log")
	TimelineResponse log(@RequestParam(required = false) @Nullable String path,
			@RequestParam(required = false) @Nullable String author,
			@RequestParam(required = false) @Nullable String since,
			@RequestParam(required = false) @Nullable String until, @RequestParam(defaultValue = "50") int limit,
			@RequestParam(defaultValue = "0") int offset) throws IOException {
		checkPage(limit, offset);
		return this.timeline.log(path, author, since, until, limit, offset);
	}

	@GetMapping("/api/history/changes")
	ChangesResponse changes(@RequestParam(required = false) @Nullable String since,
			@RequestParam(required = false) @Nullable String until,
			@RequestParam(required = false) @Nullable String path) throws IOException {
		return this.timeline.changes(since, until, path);
	}

	@GetMapping("/api/history/deleted")
	DeletedFilesResponse deleted(@RequestParam(required = false) @Nullable String q,
			@RequestParam(defaultValue = "50") int limit, @RequestParam(defaultValue = "0") int offset)
			throws IOException {
		checkPage(limit, offset);
		return this.timeline.deleted(q, limit, offset);
	}

	private static void checkPage(int limit, int offset) {
		if (limit < 1 || limit > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		if (offset < 0) {
			throw NotesException.badRequest("offset must not be negative");
		}
	}

}
