package com.rjgehan.notes.support;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

import static org.awaitility.Awaitility.await;

/**
 * Reads {@code /api/events} as a browser's {@code EventSource} would and records every frame, so tests can assert
 * which events an operation published, in which order, and to whom.
 */
public final class SseRecorder implements AutoCloseable {

	/**
	 * One dispatched event; {@code id} is null for frames without an {@code id:} line ({@code ping}).
	 * {@code receivedNanos} is the {@link System#nanoTime()} at which it was read.
	 */
	public record Frame(@Nullable String id, String event, JsonNode data, long receivedNanos) {
	}

	private final List<Frame> frames = new ArrayList<>();

	private volatile boolean ended;

	private final InputStream body;

	private final HttpResponse<InputStream> response;

	private SseRecorder(HttpResponse<InputStream> response) {
		this.response = response;
		this.body = response.body();
		Thread.ofVirtual().name("sse-recorder").start(this::read);
	}

	/** Connects as {@code clientId}, resuming after {@code lastEventId} when it is not null. */
	public static SseRecorder open(int port, String clientId, @Nullable String lastEventId) {
		String uri = "http://localhost:" + port + "/api/events?clientId=" + Api.enc(clientId)
				+ ((lastEventId != null) ? "&lastEventId=" + Api.enc(lastEventId) : "");
		HttpRequest request = HttpRequest.newBuilder(URI.create(uri)).header("Accept", "text/event-stream").build();
		try {
			HttpResponse<InputStream> response = HttpClient.newHttpClient()
				.send(request, HttpResponse.BodyHandlers.ofInputStream());
			if (response.statusCode() != 200) {
				throw new IllegalStateException("The event stream answered " + response.statusCode());
			}
			SseRecorder recorder = new SseRecorder(response);
			recorder.awaitFrames((frames) -> !frames.isEmpty());
			return recorder;
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException(ex);
		}
	}

	public HttpResponse<InputStream> response() {
		return this.response;
	}

	/** Every frame received so far. */
	public List<Frame> frames() {
		synchronized (this.frames) {
			return List.copyOf(this.frames);
		}
	}

	/** Frames other than {@code hello} and {@code ping}, as {@code event} names. */
	public List<String> eventNames() {
		return frames().stream()
			.map(Frame::event)
			.filter((name) -> !name.equals("hello") && !name.equals("ping"))
			.toList();
	}

	/** Waits until the recorded frames satisfy {@code condition} and returns them. */
	public List<Frame> awaitFrames(Predicate<List<Frame>> condition) {
		await().atMost(Duration.ofSeconds(10)).until(() -> condition.test(frames()));
		return frames();
	}

	/** Waits until an event with this name arrives and returns the frames up to and including it. */
	public List<String> awaitEvent(String name) {
		awaitFrames((frames) -> frames.stream().anyMatch((frame) -> frame.event().equals(name)));
		return eventNames();
	}

	private void read() {
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(this.body, StandardCharsets.UTF_8))) {
			String id = null;
			String event = "message";
			StringBuilder data = null;
			String line;
			while ((line = reader.readLine()) != null) {
				if (line.isEmpty()) {
					if (data != null) {
						Frame frame = new Frame(id, event, Api.JSON.readTree(data.toString()),
								System.nanoTime());
						synchronized (this.frames) {
							this.frames.add(frame);
						}
					}
					id = null;
					event = "message";
					data = null;
					continue;
				}
				if (line.startsWith(":")) {
					continue;
				}
				int colon = line.indexOf(':');
				String field = (colon < 0) ? line : line.substring(0, colon);
				String value = (colon < 0) ? "" : line.substring(colon + 1);
				if (value.startsWith(" ")) {
					value = value.substring(1);
				}
				switch (field) {
					case "id" -> id = value;
					case "event" -> event = value;
					case "data" -> data = (data == null) ? new StringBuilder(value) : data.append('\n').append(value);
					default -> {
					}
				}
			}
		}
		catch (IOException ex) {
			// The stream was closed.
		}
		finally {
			this.ended = true;
		}
	}

	/** True once the server has ended the stream (or it was closed). */
	public boolean ended() {
		return this.ended;
	}

	@Override
	public void close() {
		try {
			this.body.close();
		}
		catch (IOException ex) {
			// Already closed.
		}
	}

}
