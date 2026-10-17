package com.rjgehan.notes.events;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import com.rjgehan.notes.api.dto.FileEntry;
import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.config.JsonConfig;
import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

class EventHubTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().addModule(JsonConfig.notesModule()).build();

	private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-16T14:05:00.002Z"), ZoneOffset.UTC);

	private static EventHub hub(int replayBuffer) {
		return new EventHub(TestProperties.forVault(Path.of("vault"),
				Map.of("notes.sse.replay-buffer", String.valueOf(replayBuffer), "notes.build-sha", "test-build")),
				CLOCK);
	}

	private static FileEvent changed(String path, String origin) {
		return FileEvent.changed(new FileEntry(path, path, path, "md", FileKind.NOTE, 1, Instant.EPOCH, "v", List.of()),
				origin);
	}

	/** One parsed SSE frame. */
	record Frame(String id, String event, String data, String comment) {

		static Frame parse(String text) {
			String id = null;
			String event = null;
			String data = null;
			String comment = null;
			for (String line : text.split("\n")) {
				if (line.startsWith("id:")) {
					id = line.substring(3);
				}
				else if (line.startsWith("event:")) {
					event = line.substring(6);
				}
				else if (line.startsWith("data:")) {
					data = line.substring(5);
				}
				else if (line.startsWith(":")) {
					comment = line.substring(1);
				}
			}
			return new Frame(id, event, data, comment);
		}

	}

	/** Captures frames instead of writing them to a response. */
	static final class RecordingEmitter extends SseEmitter {

		final List<Frame> frames = new CopyOnWriteArrayList<>();

		volatile CountDownLatch gate;

		volatile boolean completed;

		volatile Runnable timeoutCallback;

		@Override
		public void send(SseEventBuilder builder) throws IOException {
			CountDownLatch blocker = this.gate;
			if (blocker != null) {
				try {
					blocker.await(10, TimeUnit.SECONDS);
				}
				catch (InterruptedException ex) {
					Thread.currentThread().interrupt();
				}
			}
			StringBuilder text = new StringBuilder();
			for (ResponseBodyEmitter.DataWithMediaType item : builder.build()) {
				Object data = item.getData();
				text.append((data instanceof String s) ? s : MAPPER.writeValueAsString(data));
			}
			this.frames.add(Frame.parse(text.toString()));
		}

		@Override
		public void complete() {
			this.completed = true;
		}

		@Override
		public synchronized void onTimeout(Runnable callback) {
			this.timeoutCallback = callback;
			super.onTimeout(callback);
		}

		List<Frame> awaitFrames(int count) {
			await().atMost(Duration.ofSeconds(10)).until(() -> this.frames.size() >= count);
			return List.copyOf(this.frames);
		}

	}

	@Test
	void helloComesFirstWithBuildShaAndRetry() {
		EventHub hub = hub(1024);
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", null);
		Frame hello = emitter.awaitFrames(1).get(0);
		assertThat(hello.event()).isEqualTo("hello");
		assertThat(hello.id()).isEqualTo(hub.bootId() + ".0");
		assertThat(hello.data()).contains("\"resync\":true").contains("\"replayed\":0")
			.contains("\"buildSha\":\"test-build\"").contains("\"serverTime\":\"2026-10-16T14:05:00.002Z\"");
	}

	@Test
	void ownContentEventsAreNotEchoed() {
		EventHub hub = hub(1024);
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", null);
		hub.publish(changed("Mine.md", "client-a1"));
		hub.publish(changed("Theirs.md", "client-b2"));
		hub.publish(new TrashChangedEvent());
		List<Frame> frames = emitter.awaitFrames(3);
		assertThat(frames).extracting(Frame::event).containsExactly("hello", "file.changed", "trash.changed");
		assertThat(frames.get(1).data()).contains("Theirs.md").contains("\"origin\":\"client-b2\"")
			.doesNotContain("change");
		assertThat(frames.get(2).data()).isEqualTo("{}");
	}

	@Test
	void replaysEventsAfterTheLastIdWithTheReplayedCount() {
		EventHub hub = hub(1024);
		hub.publish(changed("A.md", "other-client"));
		String afterFirst = hub.headEventId();
		hub.publish(changed("B.md", "other-client"));
		hub.publish(changed("C.md", "client-a1"));
		hub.publish(changed("D.md", null));
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", afterFirst);
		List<Frame> frames = emitter.awaitFrames(3);
		Frame hello = frames.get(0);
		assertThat(hello.id()).isEqualTo(afterFirst);
		assertThat(hello.data()).contains("\"resync\":false").contains("\"replayed\":2")
			.contains("\"eventId\":\"" + hub.headEventId() + "\"");
		assertThat(frames.subList(1, 3)).extracting(Frame::data)
			.satisfiesExactly((d) -> assertThat(d).contains("B.md"), (d) -> assertThat(d).contains("D.md"));
	}

	@Test
	void foreignOrTooOldIdsGetAResync() {
		EventHub hub = hub(4);
		for (int i = 0; i < 10; i++) {
			hub.publish(changed("N" + i + ".md", null));
		}
		for (String last : new String[] { "otherboot.3", hub.bootId() + ".2", "garbage", hub.bootId() + ".99" }) {
			RecordingEmitter emitter = new RecordingEmitter();
			hub.connect(emitter, "client-a1", last);
			Frame hello = emitter.awaitFrames(1).get(0);
			assertThat(hello.id()).as(last).isEqualTo(hub.headEventId());
			assertThat(hello.data()).contains("\"resync\":true").contains("\"replayed\":0");
		}
		RecordingEmitter recent = new RecordingEmitter();
		hub.connect(recent, "client-a1", hub.bootId() + ".6");
		assertThat(recent.awaitFrames(5).get(0).data()).contains("\"resync\":false").contains("\"replayed\":4");
	}

	@Test
	void pingsCarryNoIdAndNeverEnterTheRing() {
		EventHub hub = hub(1024);
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", null);
		String head = hub.headEventId();
		hub.heartbeat();
		List<Frame> frames = emitter.awaitFrames(3);
		Frame ping = frames.get(1);
		assertThat(ping.event()).isEqualTo("ping");
		assertThat(ping.id()).isNull();
		assertThat(ping.data()).contains("serverTime");
		assertThat(frames.get(2).comment()).isEqualTo("keepalive");
		assertThat(hub.headEventId()).isEqualTo(head);
		RecordingEmitter late = new RecordingEmitter();
		hub.connect(late, "client-b2", head);
		assertThat(late.awaitFrames(1).get(0).data()).contains("\"replayed\":0").contains("\"resync\":false");
	}

	@Test
	void concurrentPublishersProduceStrictlyIncreasingIdsInDeliveryOrder() throws Exception {
		EventHub hub = hub(4096);
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", null);
		ExecutorService pool = Executors.newFixedThreadPool(4);
		List<Future<?>> tasks = new ArrayList<>();
		for (int t = 0; t < 4; t++) {
			int thread = t;
			tasks.add(pool.submit(() -> {
				for (int i = 0; i < 250; i++) {
					hub.publish(changed("T" + thread + "-" + i + ".md", null));
				}
			}));
		}
		for (Future<?> task : tasks) {
			task.get();
		}
		pool.shutdown();
		List<Frame> frames = emitter.awaitFrames(1001);
		long previous = 0;
		for (Frame frame : frames.subList(1, frames.size())) {
			long seq = EventIds.parse(frame.id()).seq();
			assertThat(seq).isGreaterThan(previous);
			previous = seq;
		}
		assertThat(previous).isEqualTo(1000);
	}

	@Test
	void timeoutCompletesTheEmitterWithoutAnException() {
		EventHub hub = hub(1024);
		RecordingEmitter emitter = new RecordingEmitter();
		hub.connect(emitter, "client-a1", null);
		assertThat(emitter.timeoutCallback).isNotNull();
		emitter.timeoutCallback.run();
		assertThat(emitter.completed).isTrue();
	}

	@Test
	void aSlowClientDoesNotBlockOthers() {
		EventHub hub = hub(1024);
		RecordingEmitter slow = new RecordingEmitter();
		slow.gate = new CountDownLatch(1);
		RecordingEmitter fast = new RecordingEmitter();
		hub.connect(slow, "client-slow", null);
		hub.connect(fast, "client-fast", null);
		for (int i = 0; i < 20; i++) {
			hub.publish(changed("N" + i + ".md", null));
		}
		assertThat(fast.awaitFrames(21)).hasSize(21);
		assertThat(slow.frames).isEmpty();
		slow.gate.countDown();
		assertThat(slow.awaitFrames(21)).hasSize(21);
	}

	/**
	 * Like {@code ResponseBodyEmitter}: a send holds the write lock while it writes, and completing takes the same
	 * lock. Here the write is stuck, as on a stalled socket, until {@link #release}.
	 */
	static final class StalledEmitter extends SseEmitter {

		private final ReentrantLock writeLock = new ReentrantLock();

		private final CountDownLatch stuck = new CountDownLatch(1);

		volatile boolean completed;

		@Override
		public void send(SseEventBuilder builder) throws IOException {
			this.writeLock.lock();
			try {
				this.stuck.await(60, TimeUnit.SECONDS);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
			finally {
				this.writeLock.unlock();
			}
			throw new IOException("simulated: broken pipe");
		}

		@Override
		public void complete() {
			this.writeLock.lock();
			try {
				this.completed = true;
			}
			finally {
				this.writeLock.unlock();
			}
		}

		void release() {
			this.stuck.countDown();
		}

	}

	@Test
	void aStalledClientIsDroppedWithoutBlockingPublishersOrStarvingOtherClients() throws Exception {
		EventHub hub = hub(EventHub.MAX_PENDING * 2);
		StalledEmitter stalled = new StalledEmitter();
		RecordingEmitter healthy = new RecordingEmitter();
		hub.connect(stalled, "client-stalled", null);
		hub.connect(healthy, "client-healthy", null);
		int events = EventHub.MAX_PENDING + 10;
		ExecutorService publisher = Executors.newSingleThreadExecutor();
		try {
			Future<?> publishing = publisher.submit(() -> {
				for (int i = 0; i < events; i++) {
					hub.publish(changed("N" + i + ".md", null));
				}
			});
			// Neither an exception nor a wait for the stalled client's write lock.
			publishing.get(20, TimeUnit.SECONDS);
			await().atMost(Duration.ofSeconds(10)).until(() -> hub.connectionCount() == 1);
			List<Frame> frames = healthy.awaitFrames(events + 1);
			assertThat(frames).hasSize(events + 1);
			assertThat(frames.get(events).id()).isEqualTo(hub.headEventId());
			assertThat(stalled.completed).as("completed only once its stuck write gives up").isFalse();
		}
		finally {
			stalled.release();
			publisher.shutdownNow();
		}
		await().atMost(Duration.ofSeconds(10)).until(() -> stalled.completed);
	}

	@Test
	void closeAllCompletesEveryStream() {
		EventHub hub = hub(1024);
		RecordingEmitter first = new RecordingEmitter();
		RecordingEmitter second = new RecordingEmitter();
		hub.connect(first, "client-a1", null);
		hub.connect(second, "client-b2", null);
		assertThat(hub.connectionCount()).isEqualTo(2);
		hub.closeAll();
		assertThat(first.completed).isTrue();
		assertThat(second.completed).isTrue();
		assertThat(hub.connectionCount()).isZero();
	}

}
