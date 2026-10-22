package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.CreateVaultRequest;
import com.rjgehan.notes.api.dto.VaultInfo;
import com.rjgehan.notes.api.dto.VaultsResponse;
import com.rjgehan.notes.vaults.ServerWide;
import com.rjgehan.notes.vaults.VaultRegistry;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/vaults} and {@code POST /api/vaults} (API.md §38): the server's vaults. Server-wide, so only the
 * unprefixed path answers; {@code /api/v/<name>/vaults} is not an endpoint.
 */
@RestController
@ServerWide
public class VaultController {

	private final VaultRegistry registry;

	public VaultController(VaultRegistry registry) {
		this.registry = registry;
	}

	@GetMapping("/api/vaults")
	VaultsResponse list() {
		return new VaultsResponse(this.registry.list().stream().map(VaultController::dto).toList(),
				this.registry.canCreate());
	}

	@PostMapping("/api/vaults")
	@ResponseStatus(HttpStatus.CREATED)
	VaultInfo create(@RequestBody CreateVaultRequest request) {
		return dto(this.registry.create(request.name()));
	}

	private static VaultInfo dto(VaultRegistry.Info info) {
		return new VaultInfo(info.name(), info.isDefault(), info.state().json(), info.url());
	}

}
