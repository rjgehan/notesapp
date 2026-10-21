package com.rjgehan.notes.api;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;

import com.rjgehan.notes.api.error.NotesException;
import org.jspecify.annotations.Nullable;

import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

/**
 * The per-boot {@code Idempotency-Key} cache (DESIGN §5.4): up to 1,000 keys for one hour, mapping
 * {@code (key, method, path)} to the first successful response. A retry with the same key gets that stored response
 * and nothing is done again; a retry arriving while the first attempt is still running waits for it. Failed attempts
 * are not stored, so they can be retried.
 */
@Component
public class IdempotencyCache {

	public static final String HEADER = "Idempotency-Key";

	static final int CAPACITY = 1000;

	static final Duration TTL = Duration.ofHours(1);

	private static final Pattern KEY = Pattern.compile("[A-Za-z0-9-]{8,64}");

	/** The work to do once per key. */
	@FunctionalInterface
	public interface Action<T> {

		ResponseEntity<T> run() throws IOException;

	}

	private record Key(String key, String method, String target) {
	}

	private static final class Entry {

		final CompletableFuture<@Nullable ResponseEntity<?>> result = new CompletableFuture<>();

		volatile @Nullable Instant storedAt;

	}

	private final Map<Key, Entry> entries = new LinkedHashMap<>(64, 0.75f, true) {

		// Qualified: inside this LinkedHashMap subclass, javac 25 resolves a bare Entry to the inherited Map.Entry.
		@Override
		protected boolean removeEldestEntry(Map.Entry<Key, IdempotencyCache.Entry> eldest) {
			return size() > CAPACITY;
		}

	};

	private final Clock clock;

	public IdempotencyCache(Clock clock) {
		this.clock = clock;
	}

	@SuppressWarnings("unchecked")
	public <T> ResponseEntity<T> execute(@Nullable String idempotencyKey, HttpServletRequest request,
			Action<T> action) throws IOException {
		if (idempotencyKey == null) {
			return action.run();
		}
		if (!KEY.matcher(idempotencyKey).matches()) {
			throw NotesException.badRequest("Idempotency-Key must be 8 to 64 letters, digits or dashes");
		}
		String query = request.getQueryString();
		Key key = new Key(idempotencyKey, request.getMethod(),
				request.getRequestURI() + ((query != null) ? "?" + query : ""));
		while (true) {
			Entry mine = new Entry();
			Entry existing;
			synchronized (this.entries) {
				evictExpired();
				existing = this.entries.get(key);
				if (existing == null) {
					this.entries.put(key, mine);
				}
			}
			if (existing == null) {
				return run(key, mine, action);
			}
			try {
				ResponseEntity<?> stored = existing.result.join();
				if (stored != null) {
					return (ResponseEntity<T>) stored;
				}
			}
			catch (CompletionException ex) {
				// The first attempt failed; this request becomes a fresh attempt.
			}
		}
	}

	private <T> ResponseEntity<T> run(Key key, Entry mine, Action<T> action) throws IOException {
		try {
			ResponseEntity<T> response = action.run();
			if (response.getStatusCode().is2xxSuccessful()) {
				mine.storedAt = this.clock.instant();
				mine.result.complete(response);
			}
			else {
				remove(key, mine);
				mine.result.complete(null);
			}
			return response;
		}
		catch (IOException | RuntimeException | Error ex) {
			remove(key, mine);
			mine.result.completeExceptionally(ex);
			throw ex;
		}
	}

	private void remove(Key key, Entry entry) {
		synchronized (this.entries) {
			this.entries.remove(key, entry);
		}
	}

	private void evictExpired() {
		Instant cutoff = this.clock.instant().minus(TTL);
		Iterator<Entry> iterator = this.entries.values().iterator();
		while (iterator.hasNext()) {
			Instant storedAt = iterator.next().storedAt;
			if (storedAt != null && storedAt.isBefore(cutoff)) {
				iterator.remove();
			}
		}
	}

}
