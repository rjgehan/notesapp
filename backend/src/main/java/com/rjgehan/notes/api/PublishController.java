package com.rjgehan.notes.api;

import java.io.IOException;

import com.rjgehan.notes.api.dto.PublishRequest;
import com.rjgehan.notes.api.dto.PublishResponse;
import com.rjgehan.notes.api.dto.PublishedNote;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.publish.PublishService;
import org.jspecify.annotations.Nullable;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Public publishing (API.md §26, ROADMAP item 26), on the tailnet-only app; the public pages are served elsewhere. */
@RestController
public class PublishController {

	private final PublishService publish;

	public PublishController(PublishService publish) {
		this.publish = publish;
	}

	@GetMapping("/api/publish")
	PublishResponse list() throws IOException {
		return this.publish.list();
	}

	@PostMapping("/api/publish")
	PublishedNote publish(@RequestBody PublishRequest request, Identity identity) throws IOException {
		return this.publish.publish(request.path(), request.slug(), request.title(), identity);
	}

	@DeleteMapping("/api/publish")
	ResponseEntity<Void> unpublish(@RequestParam(name = "path", required = false) @Nullable String path,
			Identity identity) throws IOException {
		this.publish.unpublish(path, identity);
		return ResponseEntity.noContent().build();
	}

}
