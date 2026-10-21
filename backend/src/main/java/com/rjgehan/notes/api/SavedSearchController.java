package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.SavedSearchesResponse;
import com.rjgehan.notes.api.dto.SavedSearchesUpdateRequest;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.search.SavedSearchService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Saved searches (API.md §12.4). */
@RestController
public class SavedSearchController {

	private final SavedSearchService searches;

	public SavedSearchController(SavedSearchService searches) {
		this.searches = searches;
	}

	@GetMapping("/api/searches")
	SavedSearchesResponse get() throws IOException {
		return this.searches.get();
	}

	@PutMapping("/api/searches")
	SavedSearchesResponse update(@RequestBody SavedSearchesUpdateRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.searches.update(request.searches(), request.baseVersion(), identity, origin);
	}

}
