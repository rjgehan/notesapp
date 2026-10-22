package com.rjgehan.notes.reminders;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.api.dto.CompleteTaskRequest;
import com.rjgehan.notes.api.dto.Task;
import com.rjgehan.notes.api.dto.TaskReminder;
import com.rjgehan.notes.api.dto.UpcomingReminder;
import com.rjgehan.notes.capture.MomentFormat;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.settings.DailyNotesSettings;
import com.rjgehan.notes.settings.RemindersSettings;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.tasks.TaskService;
import com.rjgehan.notes.vaults.VaultNames;
import com.rjgehan.notes.vault.PathNames;
import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * The reminder scheduler (DESIGN §5.26, ROADMAP items 9 and 4c). Every 15 seconds it looks for reminders that are due
 * and hands each to the delivery routes switched on in {@code settings.reminders}.
 * <ul>
 * <li><b>Due</b>: a task reminder's local date-time, read in the zone the devices report ({@code PUT
 * /api/reminders/zone}; the server's zone until one does), is in the last 24 hours, after the baseline, and not in the
 * ledger. Local times resolve with {@link ZonedDateTime#ofLocal}: in a DST gap they move forward by the gap, in an
 * overlap they take the earlier offset. Snoozes and the daily-note nudge are due the same way.</li>
 * <li><b>Delivered</b> once at least one route accepts it; then its key goes into the ledger, which keeps keys for 48
 * hours. A reminder no route accepted is tried again after 30 s, doubling to at most 15 minutes. Delivery is at least
 * once: a crash between sending and saving the ledger repeats that reminder.</li>
 * <li><b>Baseline</b>: with every route off, it follows the clock, so switching a route on later does not deliver a
 * day of old reminders at once. Reminders missed while the server was down are delivered when it starts.</li>
 * </ul>
 * The state lives in {@code .notesapp/reminders.json} (kept out of git like {@code trash.json}).
 */
@Component
public class ReminderScheduler implements DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(ReminderScheduler.class);

	public static final String FILE = ".notesapp/reminders.json";

	static final Duration WINDOW = Duration.ofHours(24);

	static final Duration LEDGER_KEEP = Duration.ofHours(48);

	/** With every route off, the moving baseline is saved at most this often. */
	static final Duration IDLE_SAVE = Duration.ofMinutes(10);

	static final Duration FIRST_RETRY = Duration.ofSeconds(30);

	static final Duration MAX_RETRY = Duration.ofMinutes(15);

	/** At most this many reminders go out in one tick; the rest follow in the next. */
	static final int MAX_PER_TICK = 20;

	static final int MAX_SNOOZES = 200;

	private static final int MAX_ERROR_LENGTH = 200;

	private static final DateTimeFormatter LOCAL = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm");

	private static final DateTimeFormatter SHOWN = DateTimeFormatter.ofPattern("EEE d MMM, HH:mm",
			java.util.Locale.ENGLISH);

	/** What the scheduler reads: the settings, the remindable tasks, and whether a vault file exists. */
	interface Sources {

		Settings settings();

		List<Task> tasks();

		@Nullable Task task(String id);

		boolean exists(String path);

	}

	/** Completes a task: {@link TaskService#complete} outside tests. */
	@FunctionalInterface
	interface Completer {

		void complete(String id, CompleteTaskRequest request, Identity identity, @Nullable String origin)
				throws IOException;

	}

	/** A snoozed reminder: it fires again at {@code until}. */
	record Snooze(String taskId, String at, Instant until) {

		String key() {
			return "snooze:" + this.taskId + ":" + this.at + ":" + this.until.getEpochSecond();
		}

	}

	private record Retry(int attempts, Instant next) {
	}

	/** A reminder found due. */
	private record Due(Instant when, ReminderMessage message) {
	}

	private final Sources sources;

	private final Completer completer;

	private final List<ReminderRoute> routes;

	private final Clock clock;

	private final JsonMapper mapper;

	private final Path file;

	private final Duration tick;

	private final Object lock = new Object();

	// ---- state, guarded by lock
	private boolean loaded;

	private Instant baseline = Instant.EPOCH;

	private @Nullable ZoneId zone;

	private final Map<String, Instant> ledger = new LinkedHashMap<>();

	private final List<Snooze> snoozes = new ArrayList<>();

	private boolean dirty;

	private Instant lastSave = Instant.EPOCH;

	private final Map<String, Retry> retries = new HashMap<>();

	private @Nullable Instant lastDeliveredAt;

	private @Nullable String lastError;

	private @Nullable Instant lastErrorAt;

	private @Nullable ScheduledExecutorService executor;

	/** The vault's app URL prefix (DESIGN §5.38): a notification opens the vault the reminder belongs to. */
	private String urlPrefix = "";

	@Autowired
	public ReminderScheduler(SettingsService settings, TaskService tasks, VaultFs fs, NotesProperties properties,
			List<ReminderRoute> routes, Clock clock, JsonMapper mapper,
			@Value("${notes.reminders.tick:15s}") Duration tick) {
		this(new Sources() {

			@Override
			public Settings settings() {
				return settings.current();
			}

			@Override
			public List<Task> tasks() {
				return tasks.withReminders();
			}

			@Override
			public @Nullable Task task(String id) {
				return tasks.find(id);
			}

			@Override
			public boolean exists(String path) {
				return fs.attributes(path) != null;
			}

		}, (id, request, identity, origin) -> tasks.complete(id, request, identity, origin), routes, clock, mapper,
				properties.vaultDir().resolve(FILE), tick);
		this.urlPrefix = VaultNames.urlPrefix(properties.vaults().currentName(), properties.vaults().isDefault());
	}

	ReminderScheduler(Sources sources, Completer completer, List<ReminderRoute> routes, Clock clock, JsonMapper mapper,
			Path file, Duration tick) {
		this.sources = sources;
		this.completer = completer;
		this.routes = List.copyOf(routes);
		this.clock = clock;
		this.mapper = mapper;
		this.file = file;
		this.tick = tick;
	}

	/** Starts ticking once the vault, the settings and the index are loaded. */
	@EventListener(ApplicationReadyEvent.class)
	public void start() {
		synchronized (this.lock) {
			if (this.executor != null) {
				return;
			}
			ScheduledExecutorService scheduler = Executors
				.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("reminders").daemon().factory());
			long period = Math.max(1000, this.tick.toMillis());
			scheduler.scheduleWithFixedDelay(this::tick, 1000, period, TimeUnit.MILLISECONDS);
			this.executor = scheduler;
		}
	}

	@Override
	public void destroy() {
		synchronized (this.lock) {
			if (this.executor != null) {
				this.executor.shutdownNow();
			}
		}
	}

	// ---------------------------------------------------------------- the tick

	/** Finds what is due and delivers it. Runs on the reminders thread (and directly in tests); never throws. */
	void tick() {
		try {
			synchronized (this.lock) {
				load();
				Instant now = this.clock.instant();
				Settings settings = this.sources.settings();
				RemindersSettings reminders = settings.reminders();
				List<ReminderRoute> active = this.routes.stream().filter((r) -> r.enabled(reminders)).toList();
				prune(now);
				if (active.isEmpty()) {
					if (now.isAfter(this.baseline)) {
						this.baseline = now;
						this.dirty = true;
					}
					this.retries.clear();
					if (this.dirty && !now.isBefore(this.lastSave.plus(IDLE_SAVE))) {
						save(now);
					}
					return;
				}
				List<Due> due = due(settings, now);
				int sent = 0;
				for (Due item : due) {
					if (sent >= MAX_PER_TICK) {
						break;
					}
					String key = item.message().key();
					Retry retry = this.retries.get(key);
					if (retry != null && now.isBefore(retry.next())) {
						continue;
					}
					if ("daily".equals(item.message().kind()) && dailyNoteExists(settings, now)) {
						// Today's note was started before the nudge: nothing to remind of.
						this.ledger.put(key, now);
						this.dirty = true;
						continue;
					}
					sent++;
					deliver(item.message(), reminders, active, now);
				}
				if (this.dirty) {
					save(now);
				}
			}
		}
		catch (RuntimeException ex) {
			logger.warn("The reminder scheduler's tick failed; it will run again: {}", ex.toString());
		}
	}

	private void deliver(ReminderMessage due, RemindersSettings settings, List<ReminderRoute> active, Instant now) {
		ReminderMessage message = due.withUrlPrefix(this.urlPrefix);
		boolean accepted = false;
		List<String> errors = new ArrayList<>();
		for (ReminderRoute route : active) {
			ReminderRoute.Delivery delivery;
			try {
				delivery = route.deliver(message, settings);
			}
			catch (RuntimeException ex) {
				delivery = ReminderRoute.Delivery.failed(describe(ex));
			}
			if (delivery.accepted()) {
				accepted = true;
			}
			else {
				errors.add(route.id() + ": " + delivery.error());
			}
		}
		String key = message.key();
		if (accepted) {
			this.ledger.put(key, now);
			this.retries.remove(key);
			if (key.startsWith("snooze:")) {
				this.snoozes.removeIf((s) -> s.key().equals(key));
			}
			this.dirty = true;
			this.lastDeliveredAt = now;
			logger.debug("REMINDER delivered {}", key);
		}
		else {
			Retry previous = this.retries.get(key);
			int attempts = (previous != null) ? previous.attempts() + 1 : 1;
			Duration wait = FIRST_RETRY.multipliedBy(1L << Math.min(attempts - 1, 10));
			if (wait.compareTo(MAX_RETRY) > 0) {
				wait = MAX_RETRY;
			}
			this.retries.put(key, new Retry(attempts, now.plus(wait)));
		}
		if (!errors.isEmpty()) {
			this.lastError = shorten(String.join("; ", errors));
			this.lastErrorAt = now;
			if (!accepted) {
				logger.info("No route accepted a reminder; retrying later ({})", this.lastError);
			}
		}
	}

	/** Every reminder due now, oldest first. Holds {@code lock}. */
	private List<Due> due(Settings settings, Instant now) {
		ZoneId zoneId = zone();
		Instant from = now.minus(WINDOW);
		List<Due> due = new ArrayList<>();
		for (Task task : this.sources.tasks()) {
			for (TaskReminder reminder : task.reminders()) {
				Instant when = instant(reminder.at(), zoneId);
				String key = "task:" + task.id() + ":" + reminder.at();
				if (when != null && isDue(when, from, now) && !this.ledger.containsKey(key)) {
					due.add(new Due(when, taskMessage(key, task, reminder.at(), zoneId)));
				}
			}
		}
		for (Snooze snooze : this.snoozes) {
			if (!snooze.until().isAfter(now) && !this.ledger.containsKey(snooze.key())) {
				Task task = this.sources.task(snooze.taskId());
				if (task != null && !task.status().isClosed()) {
					due.add(new Due(snooze.until(), taskMessage(snooze.key(), task, snooze.at(), zoneId)));
				}
			}
		}
		RemindersSettings reminders = settings.reminders();
		if (reminders.dailyNote()) {
			LocalDate today = now.atZone(zoneId).toLocalDate();
			Instant when = ZonedDateTime.ofLocal(LocalDateTime.of(today, LocalTime.parse(reminders.dailyNoteTime())),
					zoneId, null)
				.toInstant();
			String key = "daily:" + today;
			if (isDue(when, from, now) && !this.ledger.containsKey(key)) {
				due.add(new Due(when, new ReminderMessage(key, "daily", null, null, "Today’s daily note",
						"Start today’s daily note.", "/?open=daily")));
			}
		}
		due.sort(Comparator.comparing(Due::when));
		return due;
	}

	private boolean isDue(Instant when, Instant from, Instant now) {
		return !when.isAfter(now) && when.isAfter(from) && when.isAfter(this.baseline);
	}

	private boolean dailyNoteExists(Settings settings, Instant now) {
		DailyNotesSettings daily = settings.dailyNotes();
		try {
			String name = MomentFormat.format(daily.format(), now.atZone(zone())) + ".md";
			return this.sources.exists(PathNames.join(daily.folder(), name));
		}
		catch (RuntimeException ex) {
			return false;
		}
	}

	static ReminderMessage taskMessage(String key, Task task, String at, ZoneId zone) {
		StringBuilder body = new StringBuilder();
		if (task.due() != null) {
			body.append("Due ").append(shown(task.due(), zone));
		}
		else {
			body.append("Reminder");
		}
		if (key.startsWith("snooze:")) {
			body.append(" (snoozed)");
		}
		if (task.notes() != null && !task.notes().isBlank()) {
			body.append('\n').append(clip(task.notes().strip(), 300));
		}
		return new ReminderMessage(key, "task", task.id(), at, clip(task.title(), 200), body.toString(),
				"/x/tasks/today?task=" + task.id());
	}

	private static String shown(String value, ZoneId zone) {
		if (value.length() == 10) {
			return value;
		}
		try {
			return SHOWN.format(LocalDateTime.parse(value, LOCAL));
		}
		catch (DateTimeParseException ex) {
			return value;
		}
	}

	/** A stored local date-time as an instant in {@code zone}; null when it is not one. */
	static @Nullable Instant instant(String at, ZoneId zone) {
		try {
			return ZonedDateTime.ofLocal(LocalDateTime.parse(at, LOCAL), zone, null).toInstant();
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

	private ZoneId zone() {
		return (this.zone != null) ? this.zone : this.clock.getZone();
	}

	private void prune(Instant now) {
		Instant keepAfter = now.minus(LEDGER_KEEP);
		for (Iterator<Map.Entry<String, Instant>> it = this.ledger.entrySet().iterator(); it.hasNext();) {
			if (it.next().getValue().isBefore(keepAfter)) {
				it.remove();
				this.dirty = true;
			}
		}
		if (this.snoozes.removeIf((s) -> s.until().isBefore(now.minus(WINDOW)))) {
			this.dirty = true;
		}
	}

	// ---------------------------------------------------------------- requests

	/** {@code PUT /api/reminders/zone}: the latest device's zone wins. */
	public void setZone(ZoneId zone) {
		synchronized (this.lock) {
			load();
			if (!zone.equals(this.zone)) {
				this.zone = zone;
				this.dirty = true;
				save(this.clock.instant());
			}
		}
	}

	/**
	 * {@code POST /api/reminders/snooze}: the reminder fires again in {@code minutes}. Nothing happens when the task is
	 * closed or gone.
	 */
	public @Nullable Instant snooze(String taskId, String at, int minutes) {
		synchronized (this.lock) {
			load();
			Task task = this.sources.task(taskId);
			if (task == null || task.status().isClosed()) {
				return null;
			}
			Instant until = this.clock.instant().plus(Duration.ofMinutes(minutes));
			this.snoozes.removeIf((s) -> s.taskId().equals(taskId) && s.at().equals(at));
			if (this.snoozes.size() >= MAX_SNOOZES) {
				this.snoozes.remove(0);
			}
			this.snoozes.add(new Snooze(taskId, at, until));
			this.dirty = true;
			save(this.clock.instant());
			return until;
		}
	}

	/**
	 * {@code POST /api/reminders/done}: completes the task, but only while it is open and still has this reminder, so
	 * a late tap after another device completed (or rolled forward) the task changes nothing. A repeating task rolls
	 * forward once: the completion carries the {@code due} and {@code start} the reminder belonged to.
	 */
	public boolean done(String taskId, String at, Identity identity, @Nullable String origin) throws IOException {
		Task task = this.sources.task(taskId);
		boolean snoozed;
		synchronized (this.lock) {
			load();
			snoozed = this.snoozes.stream().anyMatch((s) -> s.taskId().equals(taskId) && s.at().equals(at));
		}
		if (task == null || task.status().isClosed()
				|| (!snoozed && task.reminders().stream().noneMatch((r) -> r.at().equals(at)))) {
			return false;
		}
		ObjectNode base = JsonNodeFactory.instance.objectNode();
		base.put("due", task.due());
		base.put("start", task.start());
		this.completer.complete(taskId, new CompleteTaskRequest(zoneId().getId(), null, base), identity, origin);
		synchronized (this.lock) {
			if (this.snoozes.removeIf((s) -> s.taskId().equals(taskId) && s.at().equals(at))) {
				this.dirty = true;
				save(this.clock.instant());
			}
		}
		return true;
	}

	/** {@code POST /api/reminders/test}: a test message through one route, whether or not it is switched on. */
	public ReminderRoute.Delivery test(String routeId, @Nullable String deviceId) {
		ReminderRoute route = this.routes.stream().filter((r) -> r.id().equals(routeId)).findFirst().orElse(null);
		if (route == null) {
			return ReminderRoute.Delivery.failed("no such route: " + routeId);
		}
		Instant now = this.clock.instant();
		ReminderMessage message = new ReminderMessage("test:" + now.toEpochMilli(), "test", null, null,
				"NotesApp test reminder", "Reminders reach this device. Task reminders arrive the same way.",
				"/settings/reminders").withUrlPrefix(this.urlPrefix);
		Settings settings = this.sources.settings();
		try {
			if (route instanceof WebPushRoute push && deviceId != null) {
				return push.deliverTo(message, deviceId);
			}
			return route.deliver(message, settings.reminders());
		}
		catch (RuntimeException ex) {
			return ReminderRoute.Delivery.failed(describe(ex));
		}
	}

	// ---------------------------------------------------------------- status

	/** The zone reminders are read in. */
	public ZoneId zoneId() {
		synchronized (this.lock) {
			load();
			return zone();
		}
	}

	public boolean zoneReported() {
		synchronized (this.lock) {
			load();
			return this.zone != null;
		}
	}

	public @Nullable Instant lastDeliveredAt() {
		synchronized (this.lock) {
			return this.lastDeliveredAt;
		}
	}

	public @Nullable String lastError() {
		synchronized (this.lock) {
			return this.lastError;
		}
	}

	public @Nullable Instant lastErrorAt() {
		synchronized (this.lock) {
			return this.lastErrorAt;
		}
	}

	/** The next {@code limit} reminders after now, soonest first. */
	public List<UpcomingReminder> upcoming(int limit) {
		ZoneId zoneId = zoneId();
		Instant now = this.clock.instant();
		record Next(Instant when, UpcomingReminder reminder) {
		}
		List<Next> next = new ArrayList<>();
		for (Task task : this.sources.tasks()) {
			for (TaskReminder reminder : task.reminders()) {
				Instant when = instant(reminder.at(), zoneId);
				if (when != null && when.isAfter(now)) {
					next.add(new Next(when, new UpcomingReminder(task.id(), clip(task.title(), 200), reminder.at())));
				}
			}
		}
		return next.stream().sorted(Comparator.comparing(Next::when)).limit(limit).map(Next::reminder).toList();
	}

	// ---------------------------------------------------------------- the file

	/** Reads the state once; a missing or unreadable file starts from now. Holds {@code lock}. */
	private void load() {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		Instant now = this.clock.instant();
		this.baseline = now;
		JsonNode root;
		try {
			root = this.mapper.readTree(Files.readAllBytes(this.file));
		}
		catch (NoSuchFileException ex) {
			this.dirty = true;
			return;
		}
		catch (IOException | JacksonException ex) {
			logger.warn("{} cannot be read ({}); reminders start from now", FILE, ex.getClass().getSimpleName());
			this.dirty = true;
			return;
		}
		if (root == null || !root.isObject()) {
			this.dirty = true;
			return;
		}
		Instant savedBaseline = parseInstant(root.path("baseline").stringValue(null));
		if (savedBaseline != null && savedBaseline.isBefore(now)) {
			this.baseline = savedBaseline;
		}
		String zoneText = root.path("zone").stringValue(null);
		if (zoneText != null) {
			try {
				this.zone = ZoneId.of(zoneText);
			}
			catch (DateTimeException ex) {
				this.zone = null;
			}
		}
		root.path("delivered").properties().forEach((entry) -> {
			Instant at = parseInstant(entry.getValue().stringValue(null));
			if (at != null) {
				this.ledger.put(entry.getKey(), at);
			}
		});
		for (JsonNode s : root.path("snoozes").values()) {
			String taskId = s.path("taskId").stringValue(null);
			String at = s.path("at").stringValue(null);
			Instant until = parseInstant(s.path("until").stringValue(null));
			if (taskId != null && at != null && until != null) {
				this.snoozes.add(new Snooze(taskId, at, until));
			}
		}
	}

	private static @Nullable Instant parseInstant(@Nullable String text) {
		if (text == null) {
			return null;
		}
		try {
			return Instant.parse(text);
		}
		catch (DateTimeParseException ex) {
			return null;
		}
	}

	/** Writes the state; a failure is logged and retried with the next change. Holds {@code lock}. */
	private void save(Instant now) {
		ObjectNode root = JsonNodeFactory.instance.objectNode();
		root.put("version", 1);
		root.put("baseline", this.baseline.toString());
		root.put("zone", (this.zone != null) ? this.zone.getId() : null);
		ObjectNode delivered = root.putObject("delivered");
		this.ledger.forEach((key, at) -> delivered.put(key, at.toString()));
		ArrayNode snoozed = root.putArray("snoozes");
		for (Snooze s : this.snoozes) {
			snoozed.addObject().put("taskId", s.taskId()).put("at", s.at()).put("until", s.until().toString());
		}
		try {
			Path dir = Objects.requireNonNull(this.file.toAbsolutePath().getParent());
			Files.createDirectories(dir);
			Path tmp = dir.resolve(".reminders.json.tmp");
			Files.write(tmp, this.mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(root));
			try {
				Files.move(tmp, this.file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			}
			catch (AtomicMoveNotSupportedException ex) {
				Files.move(tmp, this.file, StandardCopyOption.REPLACE_EXISTING);
			}
			this.dirty = false;
			this.lastSave = now;
		}
		catch (IOException ex) {
			logger.warn("Cannot write {}: {}", FILE, ex.toString());
		}
	}

	// ---------------------------------------------------------------- helpers

	/** {@code https://<first allowed host>}, the app's own address, or null without one. */
	static @Nullable String baseUrl(List<String> allowedHosts) {
		for (String host : allowedHosts) {
			String h = host.strip();
			if (!h.isEmpty() && h.contains(".") && !h.startsWith("localhost") && !h.startsWith("127.")) {
				return "https://" + h;
			}
		}
		return null;
	}

	static String describe(Exception ex) {
		String text = (ex.getMessage() != null && !ex.getMessage().isBlank())
				? ex.getClass().getSimpleName() + ": " + ex.getMessage() : ex.getClass().getSimpleName();
		return shorten(text);
	}

	static String shorten(String text) {
		String flat = text.replaceAll("\\s+", " ");
		return (flat.length() > MAX_ERROR_LENGTH) ? flat.substring(0, MAX_ERROR_LENGTH) + "…" : flat;
	}

	static String clip(String text, int max) {
		return (text.length() > max) ? text.substring(0, max - 1) + "…" : text;
	}

}
