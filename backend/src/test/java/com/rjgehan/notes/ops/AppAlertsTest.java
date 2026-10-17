package com.rjgehan.notes.ops;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import com.rjgehan.notes.api.dto.AlertsState;
import com.rjgehan.notes.api.dto.AlertsStatus;
import com.rjgehan.notes.notify.NtfyClient;
import com.rjgehan.notes.notify.NtfyConfig;
import com.rjgehan.notes.notify.NtfyConfigFile;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Deduplication, the rate limit, retries and the status of the app-error alerts (ROADMAP item 38). */
class AppAlertsTest {

	private static final NtfyConfig CONFIG = new NtfyConfig(URI.create("https://ntfy.example.com"), "default",
			"tk_token", new NtfyConfig.Alerts(true, "ops"));

	/** One published message and the topic it went to. */
	record Sent(String topic, NtfyClient.Message message) {
	}

	private final TestVault.MutableClock clock = TestVault.newClock();

	private final List<Sent> sent = new CopyOnWriteArrayList<>();

	private volatile NtfyConfigFile.Loaded loaded = new NtfyConfigFile.Loaded(CONFIG, null);

	private volatile int failuresToCome;

	private AppAlerts alerts(Map<String, String> overrides) {
		return new AppAlerts(() -> this.loaded, (config, topic, message) -> {
			if (this.failuresToCome > 0) {
				this.failuresToCome--;
				throw new IOException("ntfy answered HTTP 502");
			}
			this.sent.add(new Sent(topic, message));
		}, this.clock, TestProperties.forVault(Path.of("vault"), overrides), false);
	}

	private AppAlerts alerts() {
		return alerts(Map.of("notes.allowed-hosts", "notes.example.ts.net"));
	}

	@Test
	void aMarkerIsSentToTheAlertsTopicWithItsFixedText() {
		AppAlerts alerts = alerts();
		alerts.raise(AlertMarker.GIT_COMMIT_FAILED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).hasSize(1);
		Sent first = this.sent.get(0);
		assertThat(first.topic()).isEqualTo("ops");
		assertThat(first.message().title()).isEqualTo("NotesApp: History is not being saved");
		assertThat(first.message().body()).startsWith(AlertMarker.GIT_COMMIT_FAILED.text()).contains("GIT_COMMIT_FAILED");
		assertThat(first.message().priority()).isEqualTo(4);
		assertThat(first.message().click()).isEqualTo(URI.create("https://notes.example.ts.net/x/status"));
		AlertsStatus status = alerts.status();
		assertThat(status.state()).isEqualTo(AlertsState.ON);
		assertThat(status.server()).isEqualTo("https://ntfy.example.com");
		assertThat(status.sent()).isEqualTo(1);
		assertThat(status.lastSentAt()).isEqualTo(this.clock.instant());
		assertThat(status.recent()).singleElement().satisfies((count) -> {
			assertThat(count.marker()).isEqualTo("GIT_COMMIT_FAILED");
			assertThat(count.count()).isEqualTo(1);
		});
	}

	@Test
	void repeatsWithinTheWindowAreSummedUpOnceItEnds() {
		AppAlerts alerts = alerts();
		alerts.raise(AlertMarker.STORAGE_LOW, this.clock.instant());
		alerts.tick();
		for (int i = 0; i < 5; i++) {
			this.clock.advance(Duration.ofMinutes(5));
			alerts.raise(AlertMarker.STORAGE_LOW, this.clock.instant());
			alerts.tick();
		}
		assertThat(this.sent).hasSize(1);
		this.clock.advance(Duration.ofMinutes(40));
		alerts.tick();
		assertThat(this.sent).hasSize(2);
		NtfyClient.Message summary = this.sent.get(1).message();
		assertThat(summary.title()).endsWith("(still happening)");
		assertThat(summary.body()).startsWith("STORAGE_LOW was logged 5 more times since ");
		this.clock.advance(Duration.ofHours(2));
		alerts.tick();
		assertThat(this.sent).hasSize(2);
		alerts.raise(AlertMarker.STORAGE_LOW, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).hasSize(3);
		assertThat(alerts.status().recent().get(0).count()).isEqualTo(7);
	}

	@Test
	void differentMarkersAreNotDeduplicatedTogether() {
		AppAlerts alerts = alerts();
		alerts.raise(AlertMarker.GIT_COMMIT_FAILED, this.clock.instant());
		alerts.raise(AlertMarker.GIT_MIRROR_FAILED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).extracting((s) -> s.message().title())
			.containsExactly("NotesApp: History is not being saved", "NotesApp: The history mirror is not being updated");
	}

	@Test
	void theRateLimitHoldsAlertsBackAndTheNextOneSaysSo() {
		AppAlerts alerts = alerts(Map.of("notes.alerts.max-per-hour", "2"));
		alerts.raise(AlertMarker.GIT_COMMIT_FAILED, this.clock.instant());
		alerts.raise(AlertMarker.GIT_MIRROR_FAILED, this.clock.instant());
		alerts.raise(AlertMarker.STORAGE_LOW, this.clock.instant());
		alerts.raise(AlertMarker.SETTINGS_READ_ONLY, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).hasSize(2);
		assertThat(alerts.status().dropped()).isEqualTo(2);
		this.clock.advance(Duration.ofMinutes(61));
		alerts.raise(AlertMarker.WATCHER_DEGRADED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).hasSize(3);
		assertThat(this.sent.get(2).message().body()).contains("2 earlier alerts were held back by the rate limit");
	}

	@Test
	void aFailedSendIsRetriedTwiceThenGivenUp() {
		AppAlerts alerts = alerts();
		this.failuresToCome = 1;
		alerts.raise(AlertMarker.GIT_COMMIT_FAILED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).isEmpty();
		assertThat(alerts.status().lastError()).isEqualTo("IOException: ntfy answered HTTP 502");
		this.clock.advance(Duration.ofSeconds(31));
		alerts.tick();
		assertThat(this.sent).hasSize(1);

		this.failuresToCome = 3;
		alerts.raise(AlertMarker.STORAGE_LOW, this.clock.instant());
		alerts.tick();
		this.clock.advance(Duration.ofSeconds(31));
		alerts.tick();
		this.clock.advance(Duration.ofMinutes(3));
		alerts.tick();
		this.clock.advance(Duration.ofMinutes(10));
		alerts.tick();
		assertThat(this.sent).hasSize(1);
		assertThat(this.failuresToCome).isZero();
	}

	@Test
	void withoutNtfyMarkersAreCountedButNothingIsSent() {
		this.loaded = new NtfyConfigFile.Loaded(null, null);
		AppAlerts alerts = alerts();
		alerts.raise(AlertMarker.WATCHER_DEGRADED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).isEmpty();
		AlertsStatus status = alerts.status();
		assertThat(status.state()).isEqualTo(AlertsState.OFF);
		assertThat(status.reason()).isEqualTo("not configured");
		assertThat(status.server()).isNull();
		assertThat(status.recent()).extracting(AlertsStatus.MarkerCount::marker).containsExactly("WATCHER_DEGRADED");

		this.loaded = new NtfyConfigFile.Loaded(null, "ntfy.json is not valid JSON");
		assertThat(alerts.status().state()).isEqualTo(AlertsState.ERROR);
		assertThat(alerts.status().reason()).isEqualTo("ntfy.json is not valid JSON");

		this.loaded = new NtfyConfigFile.Loaded(new NtfyConfig(CONFIG.server(), "default", null,
				new NtfyConfig.Alerts(false, "default")), null);
		alerts.raise(AlertMarker.SETTINGS_READ_ONLY, this.clock.instant());
		alerts.tick();
		assertThat(this.sent).isEmpty();
		assertThat(alerts.status().state()).isEqualTo(AlertsState.OFF);
		assertThat(alerts.status().reason()).isEqualTo("switched off in ntfy.json");
	}

	@Test
	void aWatchdogExitJustBeforeThisStartIsReported() {
		AppAlerts alerts = alerts();
		Instant start = this.clock.instant();
		alerts.checkWatchdogRestart(null, start);
		alerts.checkWatchdogRestart(start.minus(Duration.ofHours(1)), start);
		alerts.checkWatchdogRestart(start.plusSeconds(5), start);
		alerts.tick();
		assertThat(this.sent).isEmpty();
		alerts.checkWatchdogRestart(start.minusSeconds(20), start);
		alerts.tick();
		assertThat(this.sent).singleElement()
			.satisfies((s) -> assertThat(s.message().title()).isEqualTo("NotesApp: Restarted to rejoin the Tailscale network"));
		assertThat(alerts.status().recent().get(0).lastAt()).isEqualTo(start.minusSeconds(20));
	}

	@Test
	void withoutAnAllowedHostThereIsNoLink() {
		AppAlerts alerts = alerts(Map.of());
		alerts.raise(AlertMarker.GIT_COMMIT_FAILED, this.clock.instant());
		alerts.tick();
		assertThat(this.sent.get(0).message().click()).isNull();
	}

}
