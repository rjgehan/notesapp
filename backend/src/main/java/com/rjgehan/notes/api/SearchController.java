package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.SearchResponse;
import com.rjgehan.notes.index.SearchService;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /api/search} (API.md §12.1). */
@RestController
public class SearchController {

	private final SearchService search;

	public SearchController(SearchService search) {
		this.search = search;
	}

	@GetMapping("/api/search")
	SearchResponse search(@RequestParam(defaultValue = "") String q,
			@RequestParam(defaultValue = "" + SearchService.DEFAULT_LIMIT) int limit,
			@RequestParam(defaultValue = "relevance") String sort,
			@RequestParam(defaultValue = "true") boolean prefix) {
		return this.search.search(q, limit, sort, prefix);
	}

}
