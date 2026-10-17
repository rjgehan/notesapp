package com.rjgehan.notes.events;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter.SseEventBuilder;

/**
 * SSE connections, the replay ring and the publish lock (DESIGN §5.10, API.md §16).
 * <p>
 * {@link #publish} assigns the id, stores the event and queues it to every connection in one synchronized section.
 * Services call it before releasing the lock that protects the change, so ids follow the order of changes and two
 * saves of a path are never delivered out of order. Connection setup computes its replay inside the same lock, so an
 * event published meanwhile is either replayed or delivered live, never both and never lost. Each connection writes
 * on its own single-thread virtual-thread executor, so a slow client never blocks the others.
 * <p>
 * Publishing never blocks on a client and never throws because of one: queueing a frame only hands it to the
 * connection's executor, and a connection that falls too far behind is closed on a separate thread, because
 * completing an emitter waits for a write that a stalled socket may hold.
 */
@Component
public class EventHub {

	private static final Logger logger = LoggerFactory.getLogger(EventHub.class);

	static final long RETRY_MILLIS = 3000;

	/** A connection that falls this far behind is closed; the client reconnects and catches up by replay. */
	static final int MAX_PENDING = 4096;

	private record Stored(long seq, String id, VaultEvent event) {
	}

	private final String bootId;

	private final int capacity;

	private final Duration timeout;

	private final String buildSha;

	private final Clock clock;

	private final Object lock = new Object();

	private long seq;

	private final ArrayDeque<Stored> ring = new ArrayDeque<>();

	private final Set<Connection> connections = new LinkedHashSet<>();

	public EventHub(NotesProperties properties, Clock clock) {
		this.clock = clock;
		this.bootId = Long.toString(clock.millis(), 36);
		this.capacity = properties.sse().replayBuffer();
		this.timeout = properties.sse().timeout();
		this.buildSha = properties.buildSha();
	}

	public String bootId() {
		return this.bootId;
	}

	/** The id of the last published event; snapshot endpoints read it before taking their snapshot. */
	public String headEventId() {
		synchronized (this.lock) {
			return EventIds.format(this.bootId, this.seq);
		}
	}

	/** A new emitter with the configured stream lifetime. */
	public SseEmitter newEmitter() {
		return new SseEmitter(this.timeout.toMillis());
	}

	public void publish(VaultEvent event) {
		if (event instanceof HelloEvent || event instanceof PingEvent) {
			throw new IllegalArgumentException(event.eventName() + " is written per connection, never published");
		}
		synchronized (this.lock) {
			this.seq++;
			Stored stored = new Stored(this.seq, EventIds.format(this.bootId, this.seq), event);
			this.ring.addLast(stored);
			while (this.ring.size() > this.capacity) {
				this.ring.removeFirst();
			}
			// A snapshot, so that nothing one connection does can disturb the delivery to the others.
			for (Connection connection : this.connections.toArray(new Connection[0])) {
				try {
					if (!connection.suppresses(event)) {
						connection.enqueue(() -> frame(stored));
					}
				}
				catch (RuntimeException ex) {
					logger.warn("Closing an event stream that could not queue an event", ex);
					connection.closeLater();
				}
			}
		}
	}

	/**
	 * Registers a connection: {@code hello}, then the replayed events after {@code lastEventId} when it is replayable,
	 * then live events.
	 */
	public SseEmitter connect(SseEmitter emitter, String clientId, @Nullable String lastEventId) {
		Connection connection = new Connection(clientId, emitter);
		emitter.onTimeout(emitter::complete);
		emitter.onError((ex) -> emitter.complete());
		emitter.onCompletion(connection::detach);
		synchronized (this.lock) {
			EventIds.EventId last = EventIds.parse(lastEventId);
			String head = EventIds.format(this.bootId, this.seq);
			boolean replayable = lastEventId != null && last != null && last.bootId().equals(this.bootId)
					&& last.seq() <= this.seq && last.seq() >= this.seq - this.ring.size();
			List<Stored> replay = new ArrayList<>();
			if (replayable) {
				for (Stored stored : this.ring) {
					if (stored.seq() > last.seq() && !connection.suppresses(stored.event())) {
						replay.add(stored);
					}
				}
			}
			HelloEvent hello = new HelloEvent(this.bootId, head, !replayable, replay.size(), this.buildSha,
					this.clock.instant());
			String helloId = replayable ? lastEventId : head;
			connection.enqueue(() -> SseEmitter.event()
				.reconnectTime(RETRY_MILLIS)
				.name(hello.eventName())
				.id(helloId)
				.data(hello, MediaType.APPLICATION_JSON));
			for (Stored stored : replay) {
				connection.enqueue(() -> frame(stored));
			}
			this.connections.add(connection);
		}
		return emitter;
	}

	/** The heartbeat: a named {@code ping} without an {@code id:} line, then a comment for proxies. */
	@Scheduled(fixedDelayString = "${notes.sse.heartbeat:20s}", initialDelayString = "${notes.sse.heartbeat:20s}")
	public void heartbeat() {
		List<Connection> snapshot;
		synchronized (this.lock) {
			snapshot = List.copyOf(this.connections);
		}
		for (Connection connection : snapshot) {
			PingEvent ping = new PingEvent(this.clock.instant());
			connection.enqueue(() -> SseEmitter.event().name(ping.eventName()).data(ping, MediaType.APPLICATION_JSON));
			connection.enqueue(() -> SseEmitter.event().comment("keepalive"));
		}
	}

	/** Completes every stream so graceful shutdown is not held up. */
	@EventListener(ContextClosedEvent.class)
	public void closeAll() {
		List<Connection> snapshot;
		synchronized (this.lock) {
			snapshot = List.copyOf(this.connections);
		}
		snapshot.forEach(Connection::close);
	}

	public int connectionCount() {
		synchronized (this.lock) {
			return this.connections.size();
		}
	}

	private static SseEventBuilder frame(Stored stored) {
		return SseEmitter.event()
			.id(stored.id())
			.name(stored.event().eventName())
			.data(stored.event(), MediaType.APPLICATION_JSON);
	}

	private final class Connection {

		private final String clientId;

		private final SseEmitter emitter;

		private final ExecutorService executor;

		private final AtomicInteger pending = new AtomicInteger();

		private final AtomicBoolean closed = new AtomicBoolean();

		Connection(String clientId, SseEmitter emitter) {
			this.clientId = clientId;
			this.emitter = emitter;
			this.executor = Executors.newSingleThreadExecutor(Thread.ofVirtual().name("sse-", 0).factory());
		}

		boolean suppresses(VaultEvent event) {
			return this.clientId.equals(event.echoOrigin());
		}

		/**
		 * Hands a frame to the writer. Never blocks, and never touches the hub's connection set or the emitter, because
		 * {@link #publish} calls it while holding the hub lock and iterating the set.
		 */
		void enqueue(Supplier<SseEventBuilder> frame) {
			if (this.closed.get()) {
				return;
			}
			if (this.pending.incrementAndGet() > MAX_PENDING) {
				this.pending.decrementAndGet();
				logger.warn("Closing an event stream that fell {} events behind", MAX_PENDING);
				closeLater();
				return;
			}
			try {
				this.executor.execute(() -> {
					try {
						if (!this.closed.get()) {
							this.emitter.send(frame.get());
						}
					}
					catch (IOException | IllegalStateException ex) {
						// A failed write is how dead clients are detected.
						close();
					}
					finally {
						this.pending.decrementAndGet();
					}
				});
			}
			catch (RejectedExecutionException ex) {
				this.pending.decrementAndGet();
			}
		}

		/** Ends the stream; the client reconnects and replays what it missed. */
		void close() {
			detach();
			try {
				this.emitter.complete();
			}
			catch (RuntimeException ex) {
				// Already completed.
			}
		}

		/**
		 * Ends the stream without blocking the caller. Frames stop being queued at once; leaving the connection set and
		 * completing the emitter happen on a separate virtual thread, because completing waits for a write in
		 * progress, which a stalled client can hold until the socket's write timeout.
		 */
		void closeLater() {
			if (markClosed()) {
				Thread.ofVirtual().name("sse-close").start(this::close);
			}
		}

		/** Leaves the connection set (also the emitter's completion callback); never called while iterating it. */
		void detach() {
			markClosed();
			synchronized (EventHub.this.lock) {
				EventHub.this.connections.remove(this);
			}
		}

		/** Stops queueing and writing frames; true for the call that closed the connection. */
		private boolean markClosed() {
			if (this.closed.compareAndSet(false, true)) {
				this.executor.shutdown();
				return true;
			}
			return false;
		}

	}

}
