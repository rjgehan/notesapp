package com.rjgehan.notes.ops;

import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import com.rjgehan.notes.api.dto.AlertsStatus;
import com.rjgehan.notes.notify.NtfyClient;
import com.rjgehan.notes.notify.NtfyConfig;
import com.rjgehan.notes.notify.NtfyConfigFile;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static org.assertj.core.api.Assertions.assertThat;

/** From a log line to an alert: which events count, and that nothing from the message leaves. */
class AlertLogBridgeTest {

	private static final Logger logger = LoggerFactory.getLogger("com.rjgehan.notes.test.AlertLogBridgeTest");

	private final List<NtfyClient.Message> sent = new CopyOnWriteArrayList<>();

	private AppAlerts alerts() {
		NtfyConfig config = new NtfyConfig(URI.create("https://ntfy.example.com"), "t", null,
				new NtfyConfig.Alerts(true, "t"));
		return new AppAlerts(() -> new NtfyConfigFile.Loaded(config, null),
				(c, topic, message) -> this.sent.add(message), TestVault.newClock(),
				TestProperties.forVault(Path.of("vault"), Map.of()), false);
	}

	@Test
	void markersLoggedAtWarnOrErrorBecomeAlertsWithoutTheMessage() {
		AppAlerts alerts = alerts();
		AlertLogBridge bridge = new AlertLogBridge(alerts);
		bridge.afterPropertiesSet();
		try {
			logger.error("GIT_COMMIT_FAILED could not commit {}", "Private/Diary entry.md",
					new IllegalStateException("PRIVATE-CONTENT in an exception"));
			logger.warn("WATCHER_DEGRADED the watcher failed ({})", "PRIVATE-CONTENT");
			logger.info("STORAGE_LOW at INFO is not an alert");
			logger.error("GIT_COMMIT_FAILEDX is not a marker");
			logger.error("Not a marker: GIT_COMMIT_FAILED");
			logger.error("SOMETHING_ELSE is not one of the markers");
		}
		finally {
			bridge.destroy();
		}
		logger.error("STORAGE_LOW after the bridge is gone");

		assertThat(alerts.status().recent()).extracting(AlertsStatus.MarkerCount::marker)
			.containsExactlyInAnyOrder("GIT_COMMIT_FAILED", "WATCHER_DEGRADED");
		alerts.tick();
		assertThat(this.sent).hasSize(2);
		assertThat(this.sent).allSatisfy((message) -> assertThat(message.title() + message.body())
			.doesNotContain("PRIVATE-CONTENT")
			.doesNotContain("Diary"));
	}

	@Test
	void theMarkerIsTheFirstWordOfThePattern() {
		assertThat(AlertMarker.of("STORAGE_LOW only {} bytes")).isEqualTo(AlertMarker.STORAGE_LOW);
		assertThat(AlertMarker.of("SETTINGS_READ_ONLY")).isEqualTo(AlertMarker.SETTINGS_READ_ONLY);
		assertThat(AlertMarker.of("TAILSCALE_WATCHDOG_EXIT\tx")).isEqualTo(AlertMarker.TAILSCALE_WATCHDOG_EXIT);
		assertThat(AlertMarker.of("STORAGE_LOW: colon")).isNull();
		assertThat(AlertMarker.of("storage_low lower case")).isNull();
		assertThat(AlertMarker.of(" STORAGE_LOW indented")).isNull();
		assertThat(AlertMarker.of("")).isNull();
		assertThat(AlertMarker.of(null)).isNull();
	}

}
