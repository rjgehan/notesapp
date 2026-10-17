package com.rjgehan.notes.api;

import java.io.IOException;

import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.CreateFolderRequest;
import com.rjgehan.notes.api.dto.FolderResult;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.FolderService;
import com.rjgehan.notes.vault.TrashService;
import org.jspecify.annotations.Nullable;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Folders (API.md §10.1, §10.2). */
@RestController
public class FolderController {

	private final FolderService folders;

	private final TrashService trash;

	public FolderController(FolderService folders, TrashService trash) {
		this.folders = folders;
		this.trash = trash;
	}

	@PostMapping("/api/folders")
	@ResponseStatus(HttpStatus.CREATED)
	FolderResult create(@Valid @RequestBody CreateFolderRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.folders.create(request.path(), identity, origin);
	}

	@DeleteMapping("/api/folders")
	TrashEntry delete(@RequestParam String path, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.trash.deleteFolder(path, identity, origin);
	}

}
