package com.rjgehan.notes.config;

import java.nio.charset.StandardCharsets;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Serves the single-page app's {@code index.html} (never cached) for its client routes, including pages registered by
 * extensions under {@code /x/**} (API.md §18).
 */
@Controller
public class SpaController {

	private final Resource index = new ClassPathResource("static/index.html");

	@GetMapping({ "/", "/n/**", "/search", "/trash", "/settings", "/settings/**", "/x/**" })
	ResponseEntity<Resource> index() {
		if (!this.index.exists()) {
			throw new NotesException(ErrorCode.NOT_FOUND, "The web app is not built into this server");
		}
		return ResponseEntity.ok()
			.cacheControl(CacheControl.noCache())
			.contentType(new MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8))
			.body(this.index);
	}

}
