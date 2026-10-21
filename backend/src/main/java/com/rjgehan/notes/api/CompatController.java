package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.CompatReport;
import com.rjgehan.notes.obsidian.CompatService;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /api/compat} (API.md §11.5): the Obsidian compatibility report (ROADMAP item 24). */
@RestController
public class CompatController {

	private final CompatService compat;

	public CompatController(CompatService compat) {
		this.compat = compat;
	}

	@GetMapping("/api/compat")
	CompatReport report() {
		return this.compat.report();
	}

}
