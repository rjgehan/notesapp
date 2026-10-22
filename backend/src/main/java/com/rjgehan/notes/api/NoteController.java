package com.rjgehan.notes.api;

import java.util.List;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.dto.BacklinksResponse;
import com.rjgehan.notes.api.dto.NoteMeta;
import com.rjgehan.notes.api.dto.NotesQueryResponse;
import com.rjgehan.notes.index.NoteQueryService;
import com.rjgehan.notes.index.NoteService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Note metadata and backlinks (API.md §11.1, §11.2), and the metadata of many notes for scripts (API.md §40.1). */
@RestController
public class NoteController {

	private final NoteService notes;

	private final NoteQueryService queries;

	public NoteController(NoteService notes, NoteQueryService queries) {
		this.notes = notes;
		this.queries = queries;
	}

	@GetMapping("/api/notes/meta")
	NoteMeta meta(@RequestParam String path) {
		return this.notes.meta(path);
	}

	@GetMapping("/api/notes/backlinks")
	BacklinksResponse backlinks(@RequestParam String path, @RequestParam(defaultValue = "false") boolean unlinked) {
		return this.notes.backlinks(path, unlinked);
	}

	@GetMapping("/api/notes/query")
	NotesQueryResponse query(HttpServletRequest request, @RequestParam(required = false) @Nullable String path,
			@RequestParam(required = false) @Nullable String folder,
			@RequestParam(required = false) @Nullable String linksTo, @RequestParam(required = false) @Nullable String q,
			@RequestParam(defaultValue = "false") boolean tasks,
			@RequestParam(defaultValue = "" + NoteQueryService.DEFAULT_LIMIT) int limit) {
		// Repeated parameters as sent: a property value may hold a comma, which Spring's List binding would split.
		return this.queries.query(path, values(request, "tag"), folder, values(request, "prop"), linksTo, q, tasks, limit);
	}

	private static List<String> values(HttpServletRequest request, String name) {
		String[] values = request.getParameterValues(name);
		return (values != null) ? List.of(values) : List.of();
	}

}
