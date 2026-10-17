package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.TreeResponse;
import com.rjgehan.notes.vault.FolderService;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /api/tree} (API.md §7). */
@RestController
public class TreeController {

	private final FolderService folders;

	public TreeController(FolderService folders) {
		this.folders = folders;
	}

	@GetMapping("/api/tree")
	TreeResponse tree() {
		return this.folders.tree();
	}

}
