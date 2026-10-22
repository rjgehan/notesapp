package com.rjgehan.notes.api;

import java.io.IOException;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.regex.Pattern;

import com.rjgehan.notes.api.dto.PushDevice;
import com.rjgehan.notes.api.dto.PushKey;
import com.rjgehan.notes.api.dto.PushSubscriptionRequest;
import com.rjgehan.notes.api.dto.ReminderActionRequest;
import com.rjgehan.notes.api.dto.ReminderActionResult;
import com.rjgehan.notes.api.dto.ReminderTestRequest;
import com.rjgehan.notes.api.dto.ReminderTestResult;
import com.rjgehan.notes.api.dto.ReminderZoneRequest;
import com.rjgehan.notes.api.dto.RemindersStatus;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.ApiGuardInterceptor;
import com.rjgehan.notes.events.EventHub;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.notify.NtfyConfig;
import com.rjgehan.notes.notify.NtfyConfigFile;
import com.rjgehan.notes.reminders.PushStore;
import com.rjgehan.notes.reminders.ReminderRoute;
import com.rjgehan.notes.reminders.ReminderScheduler;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/** Reminders and Web Push subscriptions (API.md §25, ROADMAP item 9). */
@RestController
public class ReminderController {

	private static final Logger logger = LoggerFactory.getLogger(ReminderController.class);

	private static final List<String> ROUTES = List.of("webPush", "ntfy", "inApp");

	private static final Pattern LOCAL_DATE_TIME = Pattern.compile("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}");

	private static final int DEFAULT_SNOOZE = 10;

	private static final int UPCOMING = 5;

	private final ReminderScheduler scheduler;

	private final PushStore push;

	private final NtfyConfigFile ntfy;

	private final EventHub hub;

	private final Clock clock;

	public ReminderController(ReminderScheduler scheduler, PushStore push, NtfyConfigFile ntfy, EventHub hub,
			Clock clock) {
		this.clock = clock;
		this.scheduler = scheduler;
		this.push = push;
		this.ntfy = ntfy;
		this.hub = hub;
	}

	@GetMapping("/api/reminders/status")
	RemindersStatus status() {
		String pushProblem = this.push.problem();
		PushStore.Vapid vapid = (pushProblem == null) ? this.push.vapid() : null;
		RemindersStatus.WebPush webPush = new RemindersStatus.WebPush(pushProblem == null, pushProblem,
				(vapid != null) ? vapid.publicKey() : null, devices());
		NtfyConfigFile.Loaded loaded = this.ntfy.load();
		NtfyConfig config = loaded.config();
		RemindersStatus.Ntfy ntfyStatus = new RemindersStatus.Ntfy(config != null,
				(config != null) ? null
						: (loaded.problem() != null) ? loaded.problem()
								: NtfyConfigFile.FILE_NAME + " is not in the secrets directory",
				(config != null) ? config.server().toString() : null,
				config != null && !config.remindersTopic().equals(config.topic()));
		return new RemindersStatus(this.scheduler.zoneId().getId(), this.scheduler.zoneReported(), "UTC", webPush,
				ntfyStatus, new RemindersStatus.InApp(this.hub.connectionCount()), this.scheduler.lastDeliveredAt(),
				this.scheduler.lastError(), this.scheduler.lastErrorAt(), this.scheduler.upcoming(UPCOMING));
	}

	@PutMapping("/api/reminders/zone")
	ResponseEntity<Void> zone(@RequestBody(required = false) @Nullable ReminderZoneRequest request) {
		String text = (request != null) ? request.zone() : null;
		if (text == null || text.isBlank() || text.length() > 64) {
			throw NotesException.badRequest("zone must be an IANA time zone such as Europe/Berlin");
		}
		ZoneId zone;
		try {
			zone = ZoneId.of(text.strip());
		}
		catch (DateTimeException ex) {
			throw NotesException.badRequest("zone must be an IANA time zone such as Europe/Berlin");
		}
		this.scheduler.setZone(zone);
		return ResponseEntity.noContent().build();
	}

	@PostMapping("/api/push/key")
	PushKey key() {
		try {
			return new PushKey(this.push.ensureVapid().publicKey());
		}
		catch (IOException ex) {
			logger.warn("Cannot create the Web Push key pair in {}: {}", PushStore.FILE_NAME, ex.toString());
			throw new NotesException(ErrorCode.BAD_REQUEST,
					"Web Push is unavailable: " + PushStore.FILE_NAME + " cannot be written in the secrets directory");
		}
	}

	@PostMapping("/api/push/subscriptions")
	ResponseEntity<PushDevice> subscribe(@RequestBody(required = false) @Nullable PushSubscriptionRequest request) {
		if (request == null || request.keys() == null || request.keys().p256dh() == null
				|| request.keys().auth() == null || request.endpoint() == null) {
			throw NotesException.badRequest("The body must be a push subscription: endpoint and keys.p256dh, keys.auth");
		}
		try {
			PushStore.Subscription s = this.push.subscribe(request.endpoint(), request.keys().p256dh(),
					request.keys().auth(), request.name(), this.clock.instant());
			logger.info("REMINDERS device subscribed: {}", s.name());
			return ResponseEntity.status(HttpStatus.CREATED).body(device(s));
		}
		catch (PushStore.InvalidSubscriptionException ex) {
			throw NotesException.badRequest(ex.getMessage());
		}
		catch (IOException ex) {
			logger.warn("Cannot save a push subscription: {}", ex.toString());
			throw new NotesException(ErrorCode.BAD_REQUEST,
					"Web Push is unavailable: " + PushStore.FILE_NAME + " cannot be written in the secrets directory");
		}
	}

	@DeleteMapping("/api/push/subscriptions/{id}")
	ResponseEntity<Void> unsubscribe(@PathVariable String id) throws IOException {
		if (!this.push.remove(id)) {
			throw new NotesException(ErrorCode.NOT_FOUND, "No such device: " + id);
		}
		return ResponseEntity.noContent().build();
	}

	@PostMapping("/api/reminders/test")
	ReminderTestResult test(@RequestBody(required = false) @Nullable ReminderTestRequest request) {
		String route = (request != null) ? request.route() : null;
		if (route == null || !ROUTES.contains(route)) {
			throw NotesException.badRequest("route must be one of " + String.join(", ", ROUTES));
		}
		ReminderRoute.Delivery delivery = this.scheduler.test(route, request.deviceId());
		return new ReminderTestResult(delivery.accepted(), delivery.error());
	}

	@PostMapping("/api/reminders/snooze")
	ReminderActionResult snooze(@RequestBody(required = false) @Nullable ReminderActionRequest request) {
		ReminderActionRequest r = checked(request);
		int minutes = (r.minutes() != null) ? r.minutes() : DEFAULT_SNOOZE;
		if (minutes < 1 || minutes > 24 * 60) {
			throw NotesException.badRequest("minutes must be between 1 and 1440");
		}
		Instant until = this.scheduler.snooze(r.taskId(), r.at(), minutes);
		return new ReminderActionResult(until != null, until);
	}

	@PostMapping("/api/reminders/done")
	ReminderActionResult done(@RequestBody(required = false) @Nullable ReminderActionRequest request,
			Identity identity,
			@RequestHeader(name = ApiGuardInterceptor.CLIENT_ID_HEADER, required = false) @Nullable String origin)
			throws IOException {
		ReminderActionRequest r = checked(request);
		return new ReminderActionResult(this.scheduler.done(r.taskId(), r.at(), identity, origin), null);
	}

	private static ReminderActionRequest checked(@Nullable ReminderActionRequest request) {
		if (request == null || request.taskId() == null || request.taskId().isBlank() || request.at() == null
				|| !LOCAL_DATE_TIME.matcher(request.at()).matches()) {
			throw NotesException.badRequest("The body needs taskId and at (YYYY-MM-DDTHH:mm)");
		}
		return request;
	}

	private List<PushDevice> devices() {
		return this.push.subscriptions().stream().map(ReminderController::device).toList();
	}

	private static PushDevice device(PushStore.Subscription s) {
		return new PushDevice(s.id(), s.name(), s.createdAt(), s.lastSuccessAt(), s.lastError(), s.lastErrorAt());
	}

}
