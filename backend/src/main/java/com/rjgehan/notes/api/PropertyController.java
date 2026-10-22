package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.PropertiesResponse;
import com.rjgehan.notes.api.dto.PropertyRenameRequest;
import com.rjgehan.notes.api.dto.PropertyRenameResult;
import com.rjgehan.notes.api.dto.PropertyTypeRequest;
import com.rjgehan.notes.api.dto.PropertyTypesResponse;
import com.rjgehan.notes.api.dto.PropertyValuesResponse;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.properties.PropertyService;
import com.rjgehan.notes.properties.PropertyTypeService;
import org.jspecify.annotations.Nullable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Frontmatter properties across the vault (API.md §38, ROADMAP item 13). */
@RestController
public class PropertyController {

	private final PropertyService properties;

	private final PropertyTypeService types;

	public PropertyController(PropertyService properties, PropertyTypeService types) {
		this.properties = properties;
		this.types = types;
	}

	@GetMapping("/api/properties")
	PropertiesResponse list() throws IOException {
		return this.properties.list();
	}

	@GetMapping("/api/properties/values")
	PropertyValuesResponse values(@RequestParam(required = false) @Nullable String name) {
		return this.properties.values(name);
	}

	@GetMapping("/api/properties/types")
	PropertyTypesResponse types() throws IOException {
		return this.types.get();
	}

	@PutMapping("/api/properties/types")
	PropertyTypesResponse setType(@RequestBody PropertyTypeRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.types.set(request.name(), request.type(), identity, origin);
	}

	@PostMapping("/api/properties/rename")
	PropertyRenameResult rename(@RequestBody PropertyRenameRequest request, Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		return this.properties.rename(request.from(), request.to(), Boolean.TRUE.equals(request.dryRun()), identity,
				origin);
	}

}
