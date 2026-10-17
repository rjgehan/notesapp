package com.rjgehan.notes.watch;

import java.io.IOException;
import java.net.ConnectException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.IntConsumer;

import com.rjgehan.notes.config.NotesProperties;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Detects the orphaned network namespace after the {@code tailscale} container restarts (DESIGN §7.6). Every
 * {@code interval} it connects to tailscale's health endpoint. It is <em>armed</em> only after one successful
 * connection since the JVM started, so a health endpoint that is turned off or moved never causes a crash loop. Once
 * armed, {@code failures} consecutive <em>connection refused</em> results make it exit the JVM with status 1, so the
 * restart policy re-joins the live namespace. Any response, whatever its status, counts as a success. Exits are
 * recorded in {@code .watchdog-exits} next to the vault; after {@code maxExits} within {@code exitWindow} it only logs.
 */
@Component
public class TailscaleWatchdog implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(TailscaleWatchdog.class);

	static final String EXITS_FILE = ".watchdog-exits";

	/** What one probe found. */
	enum Probe {

		/** Something answered (any HTTP status). */
		CONNECTED,

		/** Nothing listens on the port: the namespace is orphaned, or tailscale is down. */
		REFUSED,

		/** Anything else (a timeout, a reset): not counted either way. */
		OTHER

	}

	private final NotesProperties.TailscaleWatchdog properties;

	private final Path exitsFile;

	private final Clock clock;

	private final HttpClient client;

	private final IntConsumer exit;

	private boolean armed;

	private int refused;

	private volatile @Nullable ScheduledExecutorService executor;

	@Autowired
	public TailscaleWatchdog(NotesProperties properties, Clock clock) {
		this(properties.tailscaleWatchdog(), exitsFile(properties.vaultDir()), clock,
				(status) -> Thread.ofPlatform().start(() -> System.exit(status)));
	}

	TailscaleWatchdog(NotesProperties.TailscaleWatchdog properties, Path exitsFile, Clock clock, IntConsumer exit) {
		this.properties = properties;
		this.exitsFile = exitsFile;
		this.clock = clock;
		this.exit = exit;
		this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
	}

	private static Path exitsFile(Path vaultDir) {
		Path vault = vaultDir.toAbsolutePath().normalize();
		Path parent = vault.getParent();
		return ((parent != null) ? parent : vault).resolve(EXITS_FILE);
	}

	@Override
	public void start() {
		if (!this.properties.enabled()) {
			return;
		}
		logger.info("Tailscale watchdog: probing {} every {}s", this.properties.url(),
				this.properties.interval().toSeconds());
		ScheduledExecutorService scheduler = Executors
			.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("tailscale-watchdog").daemon().factory());
		long period = this.properties.interval().toMillis();
		scheduler.scheduleWithFixedDelay(() -> record(probe()), period, period, TimeUnit.MILLISECONDS);
		this.executor = scheduler;
	}

	@Override
	public void stop() {
		ScheduledExecutorService scheduler = this.executor;
		this.executor = null;
		if (scheduler != null) {
			scheduler.shutdownNow();
		}
	}

	@Override
	public boolean isRunning() {
		return this.executor != null;
	}

	Probe probe() {
		HttpRequest request = HttpRequest.newBuilder(this.properties.url()).timeout(Duration.ofSeconds(5)).GET().build();
		try {
			this.client.send(request, HttpResponse.BodyHandlers.discarding());
			return Probe.CONNECTED;
		}
		catch (ConnectException ex) {
			return Probe.REFUSED;
		}
		catch (IOException ex) {
			return (ex.getCause() instanceof ConnectException) ? Probe.REFUSED : Probe.OTHER;
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return Probe.OTHER;
		}
	}

	/** Counts one probe result and exits once the armed watchdog has seen enough refusals in a row. */
	synchronized void record(Probe probe) {
		if (probe == Probe.CONNECTED) {
			if (!this.armed) {
				logger.info("Tailscale watchdog armed: {} answered", this.properties.url());
			}
			this.armed = true;
			this.refused = 0;
			return;
		}
		if (probe != Probe.REFUSED) {
			this.refused = 0;
			return;
		}
		if (!this.armed) {
			return;
		}
		this.refused++;
		if (this.refused < this.properties.failures()) {
			return;
		}
		this.refused = 0;
		Instant now = this.clock.instant();
		List<Instant> recent = recentExits(now);
		if (recent.size() >= this.properties.maxExits()) {
			logger.error("TAILSCALE_WATCHDOG_EXIT {} refused connections, but {} exits in the last {} already; "
					+ "not exiting again", this.properties.failures(), recent.size(), this.properties.exitWindow());
			return;
		}
		recent.add(now);
		writeExits(recent);
		logger.error("TAILSCALE_WATCHDOG_EXIT {} refused {} times in a row; exiting so the container restarts in the "
				+ "live network namespace", this.properties.url(), this.properties.failures());
		this.exit.accept(1);
	}

	private List<Instant> recentExits(Instant now) {
		List<Instant> recent = new ArrayList<>();
		try {
			if (Files.isRegularFile(this.exitsFile)) {
				for (String line : Files.readAllLines(this.exitsFile, StandardCharsets.UTF_8)) {
					try {
						Instant at = Instant.parse(line.strip());
						if (!at.isBefore(now.minus(this.properties.exitWindow()))) {
							recent.add(at);
						}
					}
					catch (DateTimeParseException ex) {
						// A damaged line counts as no exit.
					}
				}
			}
		}
		catch (IOException ex) {
			logger.warn("Cannot read {}: {}", this.exitsFile, ex.toString());
		}
		return recent;
	}

	private void writeExits(List<Instant> exits) {
		StringBuilder text = new StringBuilder();
		exits.forEach((at) -> text.append(at).append('\n'));
		try {
			Files.writeString(this.exitsFile, text, StandardCharsets.UTF_8, StandardOpenOption.CREATE,
					StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
		}
		catch (IOException ex) {
			logger.warn("Cannot write {}: {}", this.exitsFile, ex.toString());
		}
	}

}
