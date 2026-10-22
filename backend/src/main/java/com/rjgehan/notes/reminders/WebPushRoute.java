package com.rjgehan.notes.reminders;

import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.settings.RemindersSettings;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Reminders by Web Push to every subscribed device (the installed app on iOS 16.4+, desktop Chrome, Edge and
 * Firefox). The message is encrypted for each device, so the push service (Apple, Google, Mozilla) sees neither the
 * title nor the notes. Accepted when at least one device's push service accepted it; a device whose subscription
 * is gone (404 or 410) is removed.
 */
@Component
public class WebPushRoute implements ReminderRoute {

	private static final Logger logger = LoggerFactory.getLogger(WebPushRoute.class);

	/** Sends one encrypted message; {@link WebPushSender#send} outside tests. */
	@FunctionalInterface
	interface Sender {

		WebPushSender.Result send(PushStore.Subscription subscription, byte[] payload, PushStore.Vapid vapid,
				String subject, @Nullable String topic, Instant now) throws InterruptedException;

	}

	private final PushStore store;

	private final Sender sender;

	private final JsonMapper mapper;

	private final Clock clock;

	private final String subject;

	@Autowired
	public WebPushRoute(PushStore store, WebPushSender sender, JsonMapper mapper, Clock clock,
			NotesProperties properties, @Value("${notes.reminders.vapid-subject:}") String subject) {
		this(store, sender::send, mapper, clock, subject(subject, properties.allowedHosts()));
	}

	WebPushRoute(PushStore store, Sender sender, JsonMapper mapper, Clock clock, String subject) {
		this.store = store;
		this.sender = sender;
		this.mapper = mapper;
		this.clock = clock;
		this.subject = subject;
	}

	/** The VAPID contact: the configured one, else the app's own https address, else a placeholder address. */
	static String subject(@Nullable String configured, List<String> allowedHosts) {
		if (configured != null && !configured.isBlank()) {
			return configured.strip();
		}
		String base = ReminderScheduler.baseUrl(allowedHosts);
		return (base != null) ? base : "mailto:notesapp@notesapp.invalid";
	}

	@Override
	public String id() {
		return "webPush";
	}

	@Override
	public boolean enabled(RemindersSettings settings) {
		return settings.webPush();
	}

	@Override
	public Delivery deliver(ReminderMessage message, RemindersSettings settings) {
		return deliverTo(message, null);
	}

	/** Sends to every device, or to the one with {@code deviceId}. */
	Delivery deliverTo(ReminderMessage message, @Nullable String deviceId) {
		if (this.store.problem() != null) {
			return Delivery.failed(this.store.problem());
		}
		PushStore.Vapid vapid = this.store.vapid();
		List<PushStore.Subscription> devices = this.store.subscriptions()
			.stream()
			.filter((s) -> deviceId == null || s.id().equals(deviceId))
			.toList();
		if (vapid == null || devices.isEmpty()) {
			return Delivery.failed((deviceId != null) ? "no such device" : "no device is subscribed");
		}
		byte[] payload = payload(message);
		String topic = topic(message.key());
		int delivered = 0;
		String lastError = null;
		for (PushStore.Subscription device : devices) {
			Instant now = this.clock.instant();
			WebPushSender.Result result;
			try {
				result = this.sender.send(device, payload, vapid, this.subject, topic, now);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
				return (delivered > 0) ? Delivery.ACCEPTED : Delivery.failed("interrupted");
			}
			catch (RuntimeException ex) {
				result = new WebPushSender.Result(false, false, ReminderScheduler.describe(ex));
			}
			if (result.delivered()) {
				delivered++;
				this.store.record(device.id(), null, now);
			}
			else if (result.gone()) {
				lastError = device.name() + ": " + result.error();
				try {
					this.store.remove(device.id());
					logger.info("Removed the push subscription of {}: it expired", device.name());
				}
				catch (IOException ex) {
					this.store.record(device.id(), result.error(), now);
				}
			}
			else {
				lastError = device.name() + ": " + result.error();
				this.store.record(device.id(), ReminderScheduler.shorten(String.valueOf(result.error())), now);
			}
		}
		return (delivered > 0) ? Delivery.ACCEPTED : Delivery.failed(String.valueOf(lastError));
	}

	/** The JSON the service worker turns into a notification (frontend {@code src/sw/push.ts}). */
	byte[] payload(ReminderMessage message) {
		ObjectNode json = this.mapper.createObjectNode();
		json.put("title", ReminderScheduler.clip(message.title(), 200));
		json.put("body", ReminderScheduler.clip(message.body(), 600));
		json.put("tag", message.key());
		json.put("kind", message.kind());
		json.put("url", message.url());
		if (message.taskId() != null) {
			json.put("taskId", message.taskId());
		}
		if (message.at() != null) {
			json.put("at", message.at());
		}
		byte[] bytes = this.mapper.writeValueAsBytes(json);
		if (bytes.length > WebPushCrypto.MAX_PLAINTEXT) {
			json.put("body", "");
			bytes = this.mapper.writeValueAsBytes(json);
		}
		return bytes;
	}

	/** A push {@code Topic}: a later message for the same reminder replaces one still waiting for the device. */
	static String topic(String key) {
		return PushStore.idOf(key);
	}

}
