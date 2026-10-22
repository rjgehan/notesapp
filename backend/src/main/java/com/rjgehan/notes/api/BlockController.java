package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.BlockIdRequest;
import com.rjgehan.notes.api.dto.BlockIdResult;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.BlockIdService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Giving a block of a note an Obsidian block id (API.md §37, ROADMAP item 20). */
@RestController
public class BlockController {

	private final BlockIdService blocks;

	public BlockController(BlockIdService blocks) {
		this.blocks = blocks;
	}

	@PostMapping("/api/notes/block-id")
	BlockIdResult addBlockId(@RequestBody BlockIdRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.blocks.addBlockId(request.path(), request.line(), request.lineText(), request.placement(),
				request.id(), identity, origin);
	}

}
