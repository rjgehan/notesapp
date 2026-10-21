package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.BookmarksResponse;
import com.rjgehan.notes.api.dto.BookmarksUpdateRequest;
import com.rjgehan.notes.bookmarks.BookmarkService;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Bookmarks (API.md §21). */
@RestController
public class BookmarkController {

	private final BookmarkService bookmarks;

	public BookmarkController(BookmarkService bookmarks) {
		this.bookmarks = bookmarks;
	}

	@GetMapping("/api/bookmarks")
	BookmarksResponse get() throws IOException {
		return this.bookmarks.get();
	}

	@PutMapping("/api/bookmarks")
	BookmarksResponse update(@RequestBody BookmarksUpdateRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.bookmarks.update(request.items(), request.baseVersion(), identity, origin);
	}

}
