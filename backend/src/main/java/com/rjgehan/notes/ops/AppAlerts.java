package com.rjgehan.notes.ops;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.net.URI;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.EnumMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import com.rjgehan.notes.api.dto.AlertTestResult;
import com.rjgehan.notes.api.dto.AlertsState;
import com.rjgehan.notes.api.dto.AlertsStatus;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.notify.NtfyClient;
import com.rjgehan.notes.notify.NtfyConfig;
import com.rjgehan.notes.notify.NtfyConfigFile;
import com.rjgehan.notes.watch.TailscaleWatchdog;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * App-error alerts (DESIGN §5.18, ROADMAP item 38): every stable log marker ({@link AlertMarker}) is counted, and, when
 * {@code ntfy.json} configures ntfy, pushed there directly. {@link AlertLogBridge} feeds it from the log.
 * <ul>
 * <li><b>Deduplicated.</b> A marker is sent at most once per {@code notes.alerts.repeat-after} (1 hour); repeats in that
 * time are counted and summed up in one follow-up when it ends, so a flapping problem sends two messages an hour, not
 * hundreds.</li>
 * <li><b>Rate-limited.</b> At most {@code notes.alerts.max-per-hour} (10) alerts are sent in any hour; the next one
 * says how many were held back.</li>
 * <li><b>Never content.</b> Each alert is the marker's fixed text ({@link AlertMarker}), not the log message, so no
 * path, error text or note content leaves the server.</li>
 * <li><b>Off the caller's thread.</b> Sending happens on the alerts thread, with two retries (after 30 seconds and 2
 * minutes), so logging an error never waits for the network.</li>
 * </ul>
 * After an exit of the {@link TailscaleWatchdog}, whose own alert cannot leave the orphaned network namespace, the
 * restarted app sends it.
 */
@Component
public class AppAlerts implements DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(AppAlerts.class);

	private static final List<Duration> RETRIES = List.of(Duration.ofSeconds(30), Duration.ofMinutes(2));

	private static final Duration TICK = Duration.ofSeconds(15);

	private static final Duration HOUR = Duration.ofHours(1);

	/** A watchdog exit this long before the JVM started caused this start. */
	private static final Duration RESTART_WINDOW = Duration.ofMinutes(10);

	private static final int MAX_OUTBOX = 20;

	private static final int MAX_ERROR_LENGTH = 200;

	private static final DateTimeFormatter CLOCK_TIME = DateTimeFormatter.ofPattern("HH:mm")
		.withZone(ZoneId.systemDefault());

	/** Sends one message: {@link NtfyClient#publish} outside tests. */
	@FunctionalInterface
	interface Publisher {

		void publish(NtfyConfig config, String topic, NtfyClient.Message message)
				throws IOException, InterruptedException;

	}

	/** One marker's count since startup, and its repeat window; guarded by {@code state}. */
	private static final class Tally {

		long count;

		Instant lastAt = Instant.EPOCH;

		/** Until then, the marker is counted, not sent. */
		@Nullable Instant quietUntil;

		int repeats;

		@Nullable Instant repeatsSince;

	}

	private record Pending(NtfyClient.Message message, int attempt, Instant due) {
	}

	private final Supplier<NtfyConfigFile.Loaded> config;

	private final Publisher publisher;

	private final Clock clock;

	private final Duration repeatAfter;

	private final int maxPerHour;

	private final @Nullable URI statusPage;

	private final Path watchdogExits;

	private final Object state = new Object();

	private final Map<AlertMarker, Tally> tallies = new EnumMap<>(AlertMarker.class);

	private final Deque<Pending> outbox = new ArrayDeque<>();

	/** First attempts in the last hour, for the rate limit. */
	private final Deque<Instant> recentSends = new ArrayDeque<>();

	private long sent;

	private long dropped;

	private int droppedSinceLastSend;

	private @Nullable Instant lastSentAt;

	private @Nullable String lastError;

	private @Nullable Instant lastErrorAt;

	private final @Nullable ScheduledExecutorService executor;

	@Autowired
	public AppAlerts(NtfyConfigFile file, NtfyClient client, Clock clock, NotesProperties properties) {
		this(file::load, client::publish, clock, properties, true);
	}

	AppAlerts(Supplier<NtfyConfigFile.Loaded> config, Publisher publisher, Clock clock, NotesProperties properties,
			boolean ownThread) {
		this.config = config;
		this.publisher = publisher;
		this.clock = clock;
		this.repeatAfter = properties.alerts().repeatAfter();
		this.maxPerHour = Math.max(1, properties.alerts().maxPerHour());
		this.statusPage = statusPage(properties.allowedHosts());
		this.watchdogExits = TailscaleWatchdog.exitsFile(properties.vaultDir());
		if (ownThread) {
			ScheduledExecutorService scheduler = Executors
				.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("app-alerts").daemon().factory());
			long period = TICK.toMillis();
			scheduler.scheduleWithFixedDelay(this::tick, period, period, TimeUnit.MILLISECONDS);
			this.executor = scheduler;
		}
		else {
			this.executor = null;
		}
	}

	/** The status page on the first allowed host, opened when the notification is tapped. */
	private static @Nullable URI statusPage(List<String> allowedHosts) {
		if (allowedHosts.isEmpty()) {
			return null;
		}
		try {
			return URI.create("https://" + allowedHosts.get(0).strip() + "/x/status");
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}

	@Override
	public void destroy() {
		if (this.executor != null) {
			this.executor.shutdownNow();
		}
	}

	// ---------------------------------------------------------------- raising

	/** Counts a marker and, unless it was sent within the repeat window, queues its alert. Never blocks or throws. */
	public void raise(AlertMarker marker, Instant at) {
		synchronized (this.state) {
			Tally tally = this.tallies.computeIfAbsent(marker, (m) -> new Tally());
			tally.count++;
			tally.lastAt = at;
			Instant now = this.clock.instant();
			if (tally.quietUntil != null && now.isBefore(tally.quietUntil)) {
				if (tally.repeats++ == 0) {
					tally.repeatsSince = at;
				}
				return;
			}
			tally.quietUntil = now.plus(this.repeatAfter);
			queue(alert(marker), now);
		}
		wake();
	}

	/** Startup: a watchdog exit just before this JVM started is why it started; its alert is sent now. */
	@EventListener(ApplicationReadyEvent.class)
	void afterStartup() {
		checkWatchdogRestart(TailscaleWatchdog.lastExit(this.watchdogExits),
				Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime()));
	}

	void checkWatchdogRestart(@Nullable Instant lastExit, Instant jvmStart) {
		if (lastExit != null && !lastExit.isAfter(jvmStart) && lastExit.isAfter(jvmStart.minus(RESTART_WINDOW))) {
			raise(AlertMarker.TAILSCALE_WATCHDOG_EXIT, lastExit);
		}
	}

	private NtfyClient.Message alert(AlertMarker marker) {
		return new NtfyClient.Message("NotesApp: " + marker.title(),
				marker.text() + "\n\n" + marker.name() + ". Details: the status page, or docker compose logs notes.",
				marker.priority(), List.of("warning"), this.statusPage);
	}

	private NtfyClient.Message repeated(AlertMarker marker, Tally tally) {
		String since = (tally.repeatsSince != null) ? " since " + CLOCK_TIME.format(tally.repeatsSince) : "";
		String times = (tally.repeats == 1) ? "once more" : tally.repeats + " more times";
		return new NtfyClient.Message("NotesApp: " + marker.title() + " (still happening)",
				marker.name() + " was logged " + times + since + ". " + marker.text(), marker.priority(),
				List.of("warning"), this.statusPage);
	}

	/** Adds to the outbox, dropping the oldest when it is full; holds {@code state}. */
	private void queue(NtfyClient.Message message, Instant due) {
		if (this.outbox.size() >= MAX_OUTBOX) {
			this.outbox.removeFirst();
			this.dropped++;
			this.droppedSinceLastSend++;
		}
		this.outbox.addLast(new Pending(message, 0, due));
	}

	private void wake() {
		ScheduledExecutorService current = this.executor;
		if (current != null) {
			try {
				current.execute(this::tick);
			}
			catch (RejectedExecutionException ex) {
				// Shutting down; nothing more is sent.
			}
		}
	}

	// ---------------------------------------------------------------- sending

	/**
	 * Ends the repeat windows that are over (with a follow-up for markers that repeated) and delivers what is due. Runs
	 * on the alerts thread (and directly in tests); never throws.
	 */
	void tick() {
		try {
			Instant now = this.clock.instant();
			List<Pending> due = new ArrayList<>();
			synchronized (this.state) {
				this.tallies.forEach((marker, tally) -> {
					if (tally.quietUntil == null || now.isBefore(tally.quietUntil)) {
						return;
					}
					if (tally.repeats > 0) {
						queue(repeated(marker, tally), now);
						tally.repeats = 0;
						tally.repeatsSince = null;
						tally.quietUntil = now.plus(this.repeatAfter);
					}
					else {
						tally.quietUntil = null;
					}
				});
				for (Iterator<Pending> it = this.outbox.iterator(); it.hasNext();) {
					Pending pending = it.next();
					if (!now.isBefore(pending.due())) {
						due.add(pending);
						it.remove();
					}
				}
			}
			for (Pending pending : due) {
				deliver(pending, now);
			}
		}
		catch (RuntimeException ex) {
			logger.warn("The app alerts' tick failed; it will run again: {}", ex.toString());
		}
	}

	private void deliver(Pending pending, Instant now) {
		NtfyConfig current = this.config.get().config();
		if (current == null || !current.alerts().enabled()) {
			return;
		}
		NtfyClient.Message message = pending.message();
		synchronized (this.state) {
			if (pending.attempt() == 0) {
				while (!this.recentSends.isEmpty() && !this.recentSends.peekFirst().isAfter(now.minus(HOUR))) {
					this.recentSends.removeFirst();
				}
				if (this.recentSends.size() >= this.maxPerHour) {
					this.dropped++;
					this.droppedSinceLastSend++;
					return;
				}
				this.recentSends.addLast(now);
				if (this.droppedSinceLastSend > 0) {
					message = new NtfyClient.Message(message.title(),
							message.body() + "\n\n" + this.droppedSinceLastSend
									+ " earlier alerts were held back by the rate limit; see the status page.",
							message.priority(), message.tags(), message.click());
					this.droppedSinceLastSend = 0;
				}
			}
		}
		try {
			this.publisher.publish(current, current.alerts().topic(), message);
			synchronized (this.state) {
				this.sent++;
				this.lastSentAt = this.clock.instant();
			}
		}
		catch (IOException | RuntimeException ex) {
			failed(pending, message, ex, now);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
	}

	private void failed(Pending pending, NtfyClient.Message message, Exception ex, Instant now) {
		String error = describe(ex);
		boolean retry;
		synchronized (this.state) {
			this.lastError = error;
			this.lastErrorAt = now;
			retry = pending.attempt() < RETRIES.size();
			if (retry) {
				this.outbox.addFirst(
						new Pending(message, pending.attempt() + 1, now.plus(RETRIES.get(pending.attempt()))));
			}
		}
		if (retry) {
			logger.debug("Sending an app alert to ntfy failed ({}); retrying", error);
		}
		else {
			logger.warn("Could not send an app alert to ntfy ({}); giving up on it", error);
		}
	}

	private static String describe(Exception ex) {
		String text = (ex.getMessage() != null && !ex.getMessage().isBlank())
				? ex.getClass().getSimpleName() + ": " + ex.getMessage() : ex.getClass().getSimpleName();
		text = text.replaceAll("\\s+", " ");
		return (text.length() > MAX_ERROR_LENGTH) ? text.substring(0, MAX_ERROR_LENGTH) + "…" : text;
	}

	// ---------------------------------------------------------------- test

	/**
	 * {@code POST /api/alerts/test}: sends a test alert now, on the caller's thread, within the hourly limit, so the
	 * status page can say at once whether ntfy is reachable. The caller checks that alerts are on.
	 */
	public AlertTestResult sendTest() {
		NtfyConfig current = this.config.get().config();
		if (current == null || !current.alerts().enabled()) {
			return new AlertTestResult(false, "App alerts are off");
		}
		Instant now = this.clock.instant();
		synchronized (this.state) {
			while (!this.recentSends.isEmpty() && !this.recentSends.peekFirst().isAfter(now.minus(HOUR))) {
				this.recentSends.removeFirst();
			}
			if (this.recentSends.size() >= this.maxPerHour) {
				return new AlertTestResult(false,
						"At most " + this.maxPerHour + " alerts are sent in an hour; try again later");
			}
			this.recentSends.addLast(now);
		}
		NtfyClient.Message message = new NtfyClient.Message("NotesApp: test alert",
				"App alerts from NotesApp reach this topic. When something goes wrong, the alert arrives here the "
						+ "same way.",
				3, List.of("white_check_mark"), this.statusPage);
		try {
			this.publisher.publish(current, current.alerts().topic(), message);
			synchronized (this.state) {
				this.sent++;
				this.lastSentAt = this.clock.instant();
			}
			return new AlertTestResult(true, null);
		}
		catch (IOException | RuntimeException ex) {
			String error = describe(ex);
			synchronized (this.state) {
				this.lastError = error;
				this.lastErrorAt = now;
			}
			return new AlertTestResult(false, error);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return new AlertTestResult(false, "Interrupted");
		}
	}

	// ---------------------------------------------------------------- status

	/** What {@code /api/status/details} shows. */
	public AlertsStatus status() {
		NtfyConfigFile.Loaded loaded = this.config.get();
		NtfyConfig current = loaded.config();
		AlertsState alertsState;
		String reason;
		if (current == null) {
			alertsState = (loaded.problem() != null) ? AlertsState.ERROR : AlertsState.OFF;
			reason = (loaded.problem() != null) ? loaded.problem() : "not configured";
		}
		else if (!current.alerts().enabled()) {
			alertsState = AlertsState.OFF;
			reason = "switched off in " + NtfyConfigFile.FILE_NAME;
		}
		else {
			alertsState = AlertsState.ON;
			reason = null;
		}
		String server = (current != null) ? current.server().toString() : null;
		synchronized (this.state) {
			List<AlertsStatus.MarkerCount> recent = this.tallies.entrySet()
				.stream()
				.map((e) -> new AlertsStatus.MarkerCount(e.getKey().name(), e.getValue().count, e.getValue().lastAt))
				.sorted(Comparator.comparing(AlertsStatus.MarkerCount::lastAt).reversed())
				.toList();
			return new AlertsStatus(alertsState, reason, server, this.sent, this.dropped, this.lastSentAt,
					this.lastError, this.lastErrorAt, recent);
		}
	}

}
