package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.CreateVaultRequest;
import com.rjgehan.notes.api.dto.VaultInfo;
import com.rjgehan.notes.api.dto.VaultsResponse;
import com.rjgehan.notes.vaults.ServerWide;
import com.rjgehan.notes.vaults.VaultRegistry;
import com.rjgehan.notes.vaults.VaultRoutingFilter;
import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * {@code GET /api/vaults} and {@code POST /api/vaults} (API.md §41): the server's vaults. Server-wide, so only the
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
	VaultsResponse list(HttpServletRequest request) throws NoHandlerFoundException {
		unprefixedOnly(request);
		return new VaultsResponse(this.registry.list().stream().map(VaultController::dto).toList(),
				this.registry.canCreate());
	}

	@PostMapping("/api/vaults")
	@ResponseStatus(HttpStatus.CREATED)
	VaultInfo create(@RequestBody CreateVaultRequest request, HttpServletRequest http) throws NoHandlerFoundException {
		unprefixedOnly(http);
		return dto(this.registry.create(request.name()));
	}

	/**
	 * {@code /api/v/<name>/vaults} is not an endpoint (API.md §41): the default vault's own name routes into this
	 * context, so the prefixed path would otherwise reach these handlers.
	 */
	private static void unprefixedOnly(HttpServletRequest request) throws NoHandlerFoundException {
		if (VaultRoutingFilter.vaultOf(request) != null) {
			throw new NoHandlerFoundException(request.getMethod(), request.getRequestURI(), new HttpHeaders());
		}
	}

	private static VaultInfo dto(VaultRegistry.Info info) {
		return new VaultInfo(info.name(), info.isDefault(), info.state().json(), info.url());
	}

}
