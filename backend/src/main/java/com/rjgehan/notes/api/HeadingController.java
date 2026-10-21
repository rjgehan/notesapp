package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.HeadingRenameRequest;
import com.rjgehan.notes.api.dto.HeadingRenameResult;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.HeadingRenameService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Updating links after a heading is renamed (API.md §22). */
@RestController
public class HeadingController {

	private final HeadingRenameService headings;

	public HeadingController(HeadingRenameService headings) {
		this.headings = headings;
	}

	@PostMapping("/api/notes/rename-heading")
	HeadingRenameResult rename(@RequestBody HeadingRenameRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.headings.rename(request.path(), request.from(), request.to(),
				Boolean.TRUE.equals(request.dryRun()), identity, origin);
	}

}
