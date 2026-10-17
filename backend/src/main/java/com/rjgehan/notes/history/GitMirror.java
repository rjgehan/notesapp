package com.rjgehan.notes.history;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.MirrorState;
import com.rjgehan.notes.api.dto.MirrorStatus;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.events.StatusChangedEvent;
import org.eclipse.jgit.transport.CredentialsProvider;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * Pushes the vault's git history to a mirror, such as a private GitHub repository (DESIGN §5.8, ROADMAP item 2).
 * Off unless {@code notes.mirror.url} is set. A new {@code HEAD} is pushed once it has been stable for
 * {@code delay} (10 minutes), and at most {@code max-delay} (1 hour) after the first unpushed commit, so a long
 * writing session is still mirrored.
 * <ul>
 * <li><b>Fast-forward only.</b> {@link GitStore#push} never forces. When the mirror has diverged (it has commits the
 * vault lacks), pushing stops and {@code state} is {@code diverged} until a push is requested again.</li>
 * <li><b>Failures</b> (network, authentication, a refused update) are retried with backoff, logged once per streak
 * with the marker {@code GIT_MIRROR_FAILED}, and shown in {@code /api/status} and the status bar, as commit
 * failures are.</li>
 * <li><b>The token</b> is read from {@code notes.mirror.token-file} (a compose secret) right before each push and
 * kept only in the credentials of that push. It is never logged and never stored; error texts are scrubbed of it,
 * and a URL with credentials in it is refused.</li>
 * </ul>
 * Pushes run on the mirror's own thread, outside every vault and git lock, so a slow network never delays a save or
 * a commit.
 */
@Component
public class GitMirror implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(GitMirror.class);

	static final String NOT_CONFIGURED = "not configured";

	static final String HISTORY_DISABLED = "history is disabled";

	private static final Duration TICK = Duration.ofSeconds(15);

	private static final List<Duration> BACKOFF = List.of(Duration.ofMinutes(1), Duration.ofMinutes(5),
			Duration.ofMinutes(15), Duration.ofMinutes(30));

	private static final int MAX_ERROR_LENGTH = 300;

	private static final Pattern USER_INFO = Pattern.compile("://[^/\\s@]+@");

	private final GitStore git;

	private final EventHub hub;

	private final Clock clock;

	private final NotesProperties.Mirror properties;

	private final @Nullable String configurationError;

	private final @Nullable String remote;

	private final Object state = new Object();

	/** The {@code HEAD} the last tick saw, and when it first saw it. */
	private @Nullable String seenHead;

	private @Nullable Instant headSeenAt;

	/** When a commit the mirror lacks was first seen; bounds the delay by {@code max-delay}. */
	private @Nullable Instant firstUnpushedAt;

	private @Nullable String pushedCommit;

	private @Nullable Instant lastPushAt;

	private int failures;

	private @Nullable Instant nextRetryAt;

	private @Nullable Instant failingSince;

	private @Nullable String lastError;

	private boolean diverged;

	private boolean pushing;

	private boolean requested;

	private volatile @Nullable ScheduledExecutorService executor;

	public GitMirror(GitStore git, EventHub hub, Clock clock, NotesProperties properties) {
		this.git = git;
		this.hub = hub;
		this.clock = clock;
		this.properties = properties.mirror();
		String url = this.properties.url().strip();
		this.configurationError = configurationError(url, this.properties.tokenFile());
		this.remote = url.isEmpty() ? null : redact(url);
	}

	// ---------------------------------------------------------------- API

	/** What {@code /api/status} shows. */
	public MirrorStatus status() {
		String reason = disabledReason();
		String branch = (reason == null) ? branch() : null;
		synchronized (this.state) {
			if (reason != null) {
				return new MirrorStatus(MirrorState.DISABLED, reason, this.remote, null, false, null, null, null, null,
						null);
			}
			MirrorState current = this.diverged ? MirrorState.DIVERGED
					: (this.failures > 0) ? MirrorState.FAILING : MirrorState.READY;
			return new MirrorStatus(current, null, this.remote, branch, this.pushing || this.requested,
					this.pushedCommit, this.lastPushAt, nextPushAt(), this.lastError, this.failingSince);
		}
	}

	/**
	 * {@code POST /api/mirror/push}: pushes now, also after a divergence (once the mirror has been fixed) or while
	 * backing off. The push runs on the mirror's thread; {@code status.changed} announces its result.
	 * @return the status, with {@code pushing} set
	 */
	public MirrorStatus requestPush() {
		if (disabledReason() != null) {
			return status();
		}
		synchronized (this.state) {
			this.requested = true;
		}
		ScheduledExecutorService current = this.executor;
		if (current != null) {
			current.execute(this::tick);
		}
		return status();
	}

	/** Why the mirror is off, or null when it is on. */
	public @Nullable String disabledReason() {
		if (this.configurationError != null) {
			return this.configurationError;
		}
		return this.git.isEnabled() ? null : HISTORY_DISABLED;
	}

	// ---------------------------------------------------------------- tick

	/**
	 * Pushes when a push is due or was requested. Runs on the mirror's thread (and directly in tests); never throws,
	 * because an exception escaping a scheduled task would stop the mirror for good.
	 */
	void tick() {
		try {
			if (disabledReason() != null) {
				return;
			}
			String head = this.git.head();
			String branch = this.git.branch();
			if (head == null || branch == null) {
				return;
			}
			boolean manual;
			synchronized (this.state) {
				Instant now = this.clock.instant();
				if (!head.equals(this.seenHead)) {
					this.seenHead = head;
					this.headSeenAt = now;
					if (this.firstUnpushedAt == null) {
						this.firstUnpushedAt = now;
					}
				}
				if (head.equals(this.pushedCommit)) {
					this.firstUnpushedAt = null;
				}
				if (!this.requested && !isDue(now)) {
					return;
				}
				manual = this.requested;
				this.requested = false;
				this.pushing = true;
			}
			push(head, branch, manual);
		}
		catch (IOException | RuntimeException ex) {
			synchronized (this.state) {
				this.pushing = false;
			}
			logger.warn("The git mirror's tick failed; it will run again: {}", ex.toString());
		}
	}

	private boolean isDue(Instant now) {
		if (this.diverged || this.seenHead == null || this.seenHead.equals(this.pushedCommit)) {
			return false;
		}
		if (this.failures > 0) {
			return this.nextRetryAt == null || !now.isBefore(this.nextRetryAt);
		}
		Instant due = nextPushAt();
		return due != null && !now.isBefore(due);
	}

	private @Nullable Instant nextPushAt() {
		if (this.diverged || this.seenHead == null || this.seenHead.equals(this.pushedCommit)
				|| this.headSeenAt == null || this.firstUnpushedAt == null) {
			return null;
		}
		if (this.failures > 0) {
			return this.nextRetryAt;
		}
		Instant quiet = this.headSeenAt.plus(this.properties.delay());
		Instant max = this.firstUnpushedAt.plus(this.properties.maxDelay());
		return quiet.isBefore(max) ? quiet : max;
	}

	private void push(String head, String branch, boolean manual) {
		String token = null;
		GitStore.PushOutcome outcome;
		try {
			token = readToken();
			@Nullable CredentialsProvider credentials = token.isEmpty() ? null
					: new UsernamePasswordCredentialsProvider(this.properties.username(), token);
			outcome = this.git.push(this.properties.url().strip(), branch, head, credentials,
					this.properties.timeout());
		}
		catch (Exception ex) {
			outcome = new GitStore.PushOutcome(GitStore.PushStatus.REJECTED, message(ex));
		}
		String error = (outcome.message() != null) ? sanitize(outcome.message(), token) : null;
		switch (outcome.status()) {
			case PUSHED, UP_TO_DATE -> succeeded(head, branch, outcome.status() == GitStore.PushStatus.PUSHED, manual);
			case DIVERGED -> diverged(String.valueOf(error), manual);
			case REJECTED -> failed(String.valueOf(error), manual);
		}
	}

	private void succeeded(String head, String branch, boolean pushed, boolean manual) {
		boolean recovered;
		synchronized (this.state) {
			recovered = this.failures > 0 || this.diverged;
			this.pushing = false;
			this.pushedCommit = head;
			this.lastPushAt = this.clock.instant();
			this.firstUnpushedAt = null;
			this.failures = 0;
			this.nextRetryAt = null;
			this.failingSince = null;
			this.lastError = null;
			this.diverged = false;
		}
		if (pushed) {
			logger.info("Mirrored {} to {} ({})", head.substring(0, 7), this.remote, branch);
		}
		if (recovered) {
			logger.info("The git mirror is working again");
		}
		if (recovered || manual) {
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.MIRROR));
		}
	}

	private void diverged(String error, boolean manual) {
		boolean first;
		synchronized (this.state) {
			first = !this.diverged;
			this.pushing = false;
			this.diverged = true;
			this.failures = 0;
			this.nextRetryAt = null;
			if (this.failingSince == null) {
				this.failingSince = this.clock.instant();
			}
			this.lastError = error;
		}
		if (first) {
			logger.error("GIT_MIRROR_FAILED the mirror {} has diverged: {}. NotesApp never force-pushes; pushing stops "
					+ "until the mirror is fixed and a push is requested", this.remote, error);
		}
		if (first || manual) {
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.MIRROR));
		}
	}

	private void failed(String error, boolean manual) {
		boolean first;
		synchronized (this.state) {
			Instant now = this.clock.instant();
			first = this.failures == 0;
			this.pushing = false;
			this.diverged = false;
			this.failures++;
			if (this.failingSince == null) {
				this.failingSince = now;
			}
			this.lastError = error;
			this.nextRetryAt = now.plus(BACKOFF.get(Math.min(this.failures, BACKOFF.size()) - 1));
		}
		if (first) {
			logger.error("GIT_MIRROR_FAILED pushing to the mirror {} failed: {}; retrying with backoff", this.remote,
					error);
		}
		else {
			logger.debug("Pushing to the mirror failed again: {}", error);
		}
		if (first || manual) {
			this.hub.publish(new StatusChangedEvent(StatusChangedEvent.Reason.MIRROR));
		}
	}

	/** The token, stripped; empty for a {@code file:} mirror without a token file. */
	private String readToken() throws IOException {
		String file = this.properties.tokenFile().strip();
		if (file.isEmpty()) {
			return "";
		}
		Path path = Path.of(file);
		String token;
		try {
			token = Files.readString(path, StandardCharsets.UTF_8).strip();
		}
		catch (IOException ex) {
			throw new IOException("cannot read the token file " + path + " (" + ex.getClass().getSimpleName() + ")");
		}
		if (token.isEmpty()) {
			throw new IOException("the token file " + path + " is empty");
		}
		return token;
	}

	private @Nullable String branch() {
		try {
			return this.git.branch();
		}
		catch (IOException ex) {
			return null;
		}
	}

	// ---------------------------------------------------------------- configuration and texts

	/**
	 * Null when the mirror can run; otherwise why not. Only {@code https://} URLs without credentials, query or
	 * fragment (with a token file), and {@code file:} URLs (a local repository, used by the tests) are accepted.
	 */
	static @Nullable String configurationError(String url, String tokenFile) {
		if (url.isBlank()) {
			return NOT_CONFIGURED;
		}
		URI uri;
		try {
			uri = new URI(url.strip());
		}
		catch (URISyntaxException ex) {
			return "the mirror URL is not a valid URL";
		}
		String scheme = (uri.getScheme() != null) ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
		if (scheme.equals("file")) {
			return null;
		}
		if (!scheme.equals("https")) {
			return "the mirror URL must start with https://";
		}
		if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
				|| uri.getRawFragment() != null) {
			return "the mirror URL must be a plain https:// URL, without credentials, query or fragment";
		}
		if (tokenFile.isBlank()) {
			return "no token file is configured (NOTES_MIRROR_TOKEN_FILE)";
		}
		return null;
	}

	/** The URL without any user info, for logs and {@code /api/status}. */
	static String redact(String url) {
		return USER_INFO.matcher(url).replaceAll("://");
	}

	/** An error text safe to show and log: no token, no user info in URLs, bounded length. */
	static String sanitize(String message, @Nullable String token) {
		String text = message;
		if (token != null && !token.isEmpty()) {
			text = text.replace(token, "***");
		}
		text = redact(text).strip();
		if (text.isEmpty()) {
			text = "unknown error";
		}
		return (text.length() <= MAX_ERROR_LENGTH) ? text : text.substring(0, MAX_ERROR_LENGTH - 1) + "…";
	}

	/** The exception's message, with its root cause's when that adds something ("connection failed (refused)"). */
	static String message(Throwable ex) {
		Throwable root = ex;
		while (root.getCause() != null && root.getCause() != root) {
			root = root.getCause();
		}
		String text = ex.getMessage();
		String detail = root.getMessage();
		if (text == null || text.isBlank()) {
			return (detail != null && !detail.isBlank()) ? detail : ex.getClass().getSimpleName();
		}
		return (root != ex && detail != null && !detail.isBlank() && !text.contains(detail)) ? text + " (" + detail + ")"
				: text;
	}

	// ---------------------------------------------------------------- lifecycle

	@Override
	public void start() {
		String reason = disabledReason();
		if (reason != null) {
			if (!reason.equals(NOT_CONFIGURED)) {
				logger.warn("The git mirror is off: {}", reason);
			}
			return;
		}
		logger.info("Git mirror: pushing to {} about {} after each commit", this.remote, this.properties.delay());
		ScheduledExecutorService started = Executors
			.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("git-mirror").daemon().factory());
		started.scheduleWithFixedDelay(this::tick, TICK.toMillis(), TICK.toMillis(), TimeUnit.MILLISECONDS);
		this.executor = started;
	}

	@Override
	public void stop() {
		ScheduledExecutorService current = this.executor;
		this.executor = null;
		if (current != null) {
			current.shutdownNow();
		}
	}

	@Override
	public boolean isRunning() {
		return this.executor != null;
	}

}
