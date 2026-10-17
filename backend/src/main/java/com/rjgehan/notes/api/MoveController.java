package com.rjgehan.notes.api;

import java.io.IOException;

import jakarta.validation.Valid;

import com.rjgehan.notes.api.dto.MoveRequest;
import com.rjgehan.notes.api.dto.MoveResult;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.vault.MoveService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** {@code POST /api/move} (API.md §10.3). */
@RestController
public class MoveController {

	private final MoveService moves;

	public MoveController(MoveService moves) {
		this.moves = moves;
	}

	@PostMapping("/api/move")
	MoveResult move(@Valid @RequestBody MoveRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.moves.move(request.from(), request.to(), request.updateLinks(),
				Boolean.TRUE.equals(request.dryRun()), identity, origin);
	}

}
