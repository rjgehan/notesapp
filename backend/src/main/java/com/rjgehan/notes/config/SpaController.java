package com.rjgehan.notes.config;

import java.net.URI;
import java.nio.charset.StandardCharsets;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;

import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;

/**
 * Serves the single-page app's {@code index.html} (never cached) for its client routes, including pages registered by
 * extensions under {@code /x/**}, the quick-capture page {@code /capture} and the web clipper's {@code /clip} (API.md
 * §18).
 */
@Controller
public class SpaController {

	private final Resource index = new ClassPathResource("static/index.html");

	@GetMapping({ "/", "/n/**", "/search", "/trash", "/settings", "/settings/**", "/x/**", "/capture", "/clip" })
	ResponseEntity<Resource> index() {
		if (!this.index.exists()) {
			throw new NotesException(ErrorCode.NOT_FOUND, "The web app is not built into this server");
		}
		return ResponseEntity.ok()
			.cacheControl(CacheControl.noCache())
			.contentType(new MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8))
			.body(this.index);
	}

	/**
	 * The installed app's share target (DESIGN §6.27) posts here, and its service worker answers that navigation
	 * itself. Without a worker (it was being replaced, or storage was cleared) the share reaches the server, which
	 * never stores anything from a form post: it sends the browser to the capture page, which says the share was lost.
	 */
	@PostMapping("/capture/share")
	ResponseEntity<Void> shareWithoutServiceWorker() {
		return ResponseEntity.status(HttpStatus.SEE_OTHER).location(URI.create("/capture?share=lost")).build();
	}

}
