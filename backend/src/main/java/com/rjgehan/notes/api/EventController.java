package com.rjgehan.notes.api;

import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.events.EventHub;
import org.jspecify.annotations.Nullable;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** {@code GET /api/events} (API.md §16.1). */
@RestController
public class EventController {

	private final EventHub hub;

	public EventController(EventHub hub) {
		this.hub = hub;
	}

	@GetMapping("/api/events")
	ResponseEntity<SseEmitter> events(@RequestParam(required = false) @Nullable String clientId,
			@RequestParam(required = false) @Nullable String lastEventId,
			@RequestHeader(name = "Last-Event-ID", required = false) @Nullable String lastEventIdHeader) {
		if (!ApiGuardInterceptor.isValidClientId(clientId)) {
			throw NotesException.badRequest("clientId must be 8 to 64 letters, digits or dashes");
		}
		String last = (lastEventIdHeader != null && !lastEventIdHeader.isBlank()) ? lastEventIdHeader : lastEventId;
		SseEmitter emitter = this.hub.connect(this.hub.newEmitter(), clientId, last);
		return ResponseEntity.ok()
			.cacheControl(CacheControl.noCache().noTransform())
			.header("X-Accel-Buffering", "no")
			.body(emitter);
	}

}
