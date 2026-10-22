package com.rjgehan.notes.reminders;

import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.function.Supplier;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.notify.NtfyClient;
import com.rjgehan.notes.notify.NtfyConfig;
import com.rjgehan.notes.notify.NtfyConfigFile;
import com.rjgehan.notes.settings.RemindersSettings;
import org.jspecify.annotations.Nullable;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Reminders through ntfy, with the server, token and topic of {@code /data/secrets/ntfy.json} (its
 * {@code reminders.topic}, or the default topic). With "title only" (the default) the message carries the task's
 * title and nothing else from the vault; tapping it opens the task in NotesApp on the first allowed host.
 */
@Component
public class NtfyRoute implements ReminderRoute {

	/** Sends one message: {@link NtfyClient#publish} outside tests. */
	@FunctionalInterface
	interface Publisher {

		void publish(NtfyConfig config, String topic, NtfyClient.Message message)
				throws IOException, InterruptedException;

	}

	private final Supplier<NtfyConfigFile.Loaded> file;

	private final Publisher client;

	private final @Nullable String baseUrl;

	@Autowired
	public NtfyRoute(NtfyConfigFile file, NtfyClient client, NotesProperties properties) {
		this(file::load, client::publish, ReminderScheduler.baseUrl(properties.allowedHosts()));
	}

	NtfyRoute(Supplier<NtfyConfigFile.Loaded> file, Publisher client, @Nullable String baseUrl) {
		this.file = file;
		this.client = client;
		this.baseUrl = baseUrl;
	}

	@Override
	public String id() {
		return "ntfy";
	}

	@Override
	public boolean enabled(RemindersSettings settings) {
		return settings.ntfy();
	}

	@Override
	public Delivery deliver(ReminderMessage message, RemindersSettings settings) {
		NtfyConfigFile.Loaded loaded = this.file.get();
		NtfyConfig config = loaded.config();
		if (config == null) {
			return Delivery.failed((loaded.problem() != null) ? loaded.problem()
					: NtfyConfigFile.FILE_NAME + " is missing from the secrets directory");
		}
		ReminderMessage shown = settings.ntfyTitleOnly() ? message.titleOnly() : message;
		URI click = null;
		if (this.baseUrl != null) {
			try {
				click = URI.create(this.baseUrl + shown.url());
			}
			catch (IllegalArgumentException ex) {
				click = null;
			}
		}
		try {
			this.client.publish(config, config.remindersTopic(),
					new NtfyClient.Message(shown.title(), shown.body(), 4, List.of("bell"), click));
			return Delivery.ACCEPTED;
		}
		catch (IOException | RuntimeException ex) {
			return Delivery.failed(ReminderScheduler.describe(ex));
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			return Delivery.failed("interrupted");
		}
	}

}
