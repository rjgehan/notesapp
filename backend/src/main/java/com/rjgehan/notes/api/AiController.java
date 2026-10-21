package com.rjgehan.notes.api;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

import com.rjgehan.notes.ai.AiProperties;
import com.rjgehan.notes.ai.AiService;
import com.rjgehan.notes.api.dto.AiAskRequest;
import com.rjgehan.notes.api.dto.AiStatus;
import com.rjgehan.notes.api.dto.AiSummarizeRequest;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import org.jspecify.annotations.Nullable;

import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Ask your vault and summaries (API.md §24): {@code GET /api/ai/status}, and {@code POST /api/ai/ask} and
 * {@code POST /api/ai/summarize}, which answer with a stream of server-sent events. A request is checked and its
 * prompt built before the stream starts, so a refusal is an ordinary problem response; the answer is then written on
 * a virtual thread.
 */
@RestController
public class AiController {

	private final AiService service;

	private final Duration timeout;

	public AiController(AiService service, AiProperties properties) {
		this.service = service;
		this.timeout = properties.timeout().plusMinutes(1);
	}

	@GetMapping("/api/ai/status")
	AiStatus status() {
		return this.service.status();
	}

	@PostMapping("/api/ai/ask")
	ResponseEntity<SseEmitter> ask(@RequestBody AiAskRequest request,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String client) {
		return stream(this.service.prepareAsk(request), client);
	}

	@PostMapping("/api/ai/summarize")
	ResponseEntity<SseEmitter> summarize(@RequestBody AiSummarizeRequest request,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String client) {
		return stream(this.service.prepareSummarize(request), client);
	}

	private ResponseEntity<SseEmitter> stream(AiService.Prepared prepared, @Nullable String client) {
		SseEmitter emitter = new SseEmitter(this.timeout.toMillis());
		AtomicBoolean closed = new AtomicBoolean();
		emitter.onTimeout(() -> {
			closed.set(true);
			emitter.complete();
		});
		emitter.onError((ex) -> closed.set(true));
		emitter.onCompletion(() -> closed.set(true));
		String shortClient = (client != null && client.length() > 8) ? client.substring(0, 8) : client;
		AiService.Sink sink = (event, data) -> {
			if (closed.get()) {
				throw new AiService.ClientGoneException(new IOException("the stream is closed"));
			}
			try {
				emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
			}
			catch (IOException | IllegalStateException ex) {
				closed.set(true);
				throw new AiService.ClientGoneException(ex);
			}
		};
		Thread.ofVirtual().name("ai-answer").start(() -> {
			try {
				this.service.run(prepared, sink, shortClient);
			}
			finally {
				if (!closed.get()) {
					emitter.complete();
				}
			}
		});
		return ResponseEntity.ok()
			.contentType(MediaType.TEXT_EVENT_STREAM)
			.cacheControl(CacheControl.noStore())
			.header("X-Accel-Buffering", "no")
			.body(emitter);
	}

}
