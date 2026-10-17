package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.MeResponse;
import com.rjgehan.notes.identity.Identity;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /api/me} (API.md §6.1): the identity this request was admitted with. */
@RestController
public class MeController {

	@GetMapping("/api/me")
	MeResponse me(Identity identity) {
		return new MeResponse(identity.login(), identity.name(), identity.profilePicUrl(), identity.source());
	}

}
