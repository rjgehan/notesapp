package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.GraphResponse;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/graph} (API.md §11.4): the compact link graph behind the graph view (ROADMAP item 16). Files under
 * {@code settings.files.excludedPaths} are left out, as in Obsidian's graph.
 */
@RestController
public class GraphController {

	private final VaultIndex index;

	private final SettingsService settings;

	public GraphController(VaultIndex index, SettingsService settings) {
		this.index = index;
		this.settings = settings;
	}

	@GetMapping("/api/graph")
	GraphResponse graph(@RequestParam(required = false) @Nullable String since) {
		FilesSettings files = this.settings.current().files();
		String exclusionKey = Integer.toUnsignedString(files.excludedPaths().hashCode(), 36);
		return this.index.graph(files::isExcluded, exclusionKey, since);
	}

}
