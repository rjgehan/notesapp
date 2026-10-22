package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.DatedNotesResponse;
import com.rjgehan.notes.calendar.DatedNoteService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Notes dated by a frontmatter property, for the calendar (API.md §25). */
@RestController
public class CalendarController {

	private final DatedNoteService dated;

	public CalendarController(DatedNoteService dated) {
		this.dated = dated;
	}

	@GetMapping("/api/notes/by-date")
	DatedNotesResponse byDate(@RequestParam(required = false) @Nullable String from,
			@RequestParam(required = false) @Nullable String to,
			@RequestParam(required = false) @Nullable String property) {
		return this.dated.byDate(from, to, property);
	}

}
