package com.rjgehan.notes.api;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import org.junit.jupiter.api.Test;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class IdempotencyCacheTest {

	private final AtomicInteger runs = new AtomicInteger();

	private static MockHttpServletRequest request(String uri) {
		MockHttpServletRequest request = new MockHttpServletRequest("POST", uri);
		request.setRequestURI(uri);
		return request;
	}

	private ResponseEntity<String> created() {
		return ResponseEntity.status(HttpStatus.CREATED).body("result " + this.runs.incrementAndGet());
	}

	@Test
	void aRetryWithTheSameKeyGetsTheFirstResult() throws Exception {
		IdempotencyCache cache = new IdempotencyCache(Clock.systemUTC());
		ResponseEntity<String> first = cache.execute("key-123456", request("/api/files"), this::created);
		ResponseEntity<String> retry = cache.execute("key-123456", request("/api/files"), this::created);
		assertThat(retry.getBody()).isEqualTo("result 1");
		assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.CREATED);
		assertThat(first).isSameAs(retry);
		assertThat(this.runs).hasValue(1);
		cache.execute("key-123456", request("/api/attachments"), this::created);
		cache.execute(null, request("/api/files"), this::created);
		assertThat(this.runs).hasValue(3);
	}

	@Test
	void failuresAreNotStored() throws Exception {
		IdempotencyCache cache = new IdempotencyCache(Clock.systemUTC());
		assertThatThrownBy(() -> cache.execute("key-failing", request("/api/files"), () -> {
			throw NotesException.busy();
		})).isInstanceOf(NotesException.class);
		assertThat(cache.execute("key-failing", request("/api/files"), this::created).getBody()).isEqualTo("result 1");
	}

	@Test
	void entriesExpireAfterAnHour() throws Exception {
		MutableClock clock = new MutableClock();
		IdempotencyCache cache = new IdempotencyCache(clock);
		cache.execute("key-expiring", request("/api/files"), this::created);
		clock.now = clock.now.plus(Duration.ofMinutes(61));
		assertThat(cache.execute("key-expiring", request("/api/files"), this::created).getBody()).isEqualTo("result 2");
	}

	@Test
	void concurrentRetriesWaitForTheFirstAttempt() throws Exception {
		IdempotencyCache cache = new IdempotencyCache(Clock.systemUTC());
		CountDownLatch inside = new CountDownLatch(1);
		CountDownLatch release = new CountDownLatch(1);
		ExecutorService pool = Executors.newFixedThreadPool(2);
		Future<ResponseEntity<String>> first = pool.submit(() -> cache.execute("key-concurrent", request("/x"), () -> {
			inside.countDown();
			try {
				release.await();
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
			return created();
		}));
		inside.await();
		Future<ResponseEntity<String>> second = pool.submit(() -> cache.execute("key-concurrent", request("/x"),
				this::created));
		Thread.sleep(100);
		assertThat(second.isDone()).isFalse();
		release.countDown();
		assertThat(first.get().getBody()).isEqualTo("result 1");
		assertThat(second.get().getBody()).isEqualTo("result 1");
		pool.shutdown();
	}

	@Test
	void malformedKeysAreRejected() {
		IdempotencyCache cache = new IdempotencyCache(Clock.systemUTC());
		assertThatThrownBy(() -> cache.execute("short", request("/x"), this::created))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
	}

	private static final class MutableClock extends Clock {

		Instant now = Instant.parse("2026-10-16T12:00:00Z");

		@Override
		public ZoneOffset getZone() {
			return ZoneOffset.UTC;
		}

		@Override
		public Clock withZone(java.time.ZoneId zone) {
			return this;
		}

		@Override
		public Instant instant() {
			return this.now;
		}

	}

}
