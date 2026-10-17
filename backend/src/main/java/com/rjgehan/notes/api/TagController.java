package com.rjgehan.notes.api;

import com.rjgehan.notes.api.dto.TagCount;
import com.rjgehan.notes.api.dto.TagsResponse;
import com.rjgehan.notes.index.VaultIndex;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /api/tags} (API.md §12.2): every tag and implied parent, sorted case-insensitively. */
@RestController
public class TagController {

	private final VaultIndex index;

	public TagController(VaultIndex index) {
		this.index = index;
	}

	@GetMapping("/api/tags")
	TagsResponse tags() {
		return new TagsResponse(this.index.tagStats()
			.stream()
			.map((stat) -> new TagCount(stat.tag(), stat.count(), stat.total()))
			.toList());
	}

}
