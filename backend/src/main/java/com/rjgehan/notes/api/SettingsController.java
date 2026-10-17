package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.SettingsResponse;
import com.rjgehan.notes.api.dto.SettingsUpdateRequest;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.settings.SettingsService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Vault settings (API.md §5). */
@RestController
public class SettingsController {

	private final SettingsService settings;

	public SettingsController(SettingsService settings) {
		this.settings = settings;
	}

	@GetMapping("/api/settings")
	SettingsResponse get() {
		return this.settings.get();
	}

	@PutMapping("/api/settings")
	SettingsResponse update(@RequestBody SettingsUpdateRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.settings.update(request.settings(), request.baseVersion(), identity, origin);
	}

}
