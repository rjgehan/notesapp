package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.BacklinksResponse;
import com.rjgehan.notes.api.dto.NoteMeta;
import com.rjgehan.notes.index.NoteService;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Note metadata and backlinks (API.md §11.1, §11.2). */
@RestController
public class NoteController {

	private final NoteService notes;

	public NoteController(NoteService notes) {
		this.notes = notes;
	}

	@GetMapping("/api/notes/meta")
	NoteMeta meta(@RequestParam String path) {
		return this.notes.meta(path);
	}

	@GetMapping("/api/notes/backlinks")
	BacklinksResponse backlinks(@RequestParam String path, @RequestParam(defaultValue = "false") boolean unlinked) {
		return this.notes.backlinks(path, unlinked);
	}

}
