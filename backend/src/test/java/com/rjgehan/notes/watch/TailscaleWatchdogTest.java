package com.rjgehan.notes.watch;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.support.TestVault;
import com.rjgehan.notes.watch.TailscaleWatchdog.Probe;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/** Arming, the refusal streak and the exit cap of the Tailscale watchdog (DESIGN §7.6). */
class TailscaleWatchdogTest {

	@TempDir
	Path dir;

	private final TestVault.MutableClock clock = TestVault.newClock();

	private final List<Integer> exits = new ArrayList<>();

	private TailscaleWatchdog watchdog(String url) {
		NotesProperties properties = TestProperties.forVault(this.dir.resolve("vault"),
				Map.of("notes.tailscale-watchdog.enabled", "true", "notes.tailscale-watchdog.url", url));
		return new TailscaleWatchdog(properties.tailscaleWatchdog(), this.dir.resolve(".watchdog-exits"), this.clock,
				this.exits::add);
	}

	private TailscaleWatchdog watchdog() {
		return watchdog("http://127.0.0.1:9/healthz");
	}

	private static void refuse(TailscaleWatchdog watchdog, int times) {
		for (int i = 0; i < times; i++) {
			watchdog.record(Probe.REFUSED);
		}
	}

	@Test
	void refusalsBeforeTheFirstSuccessNeverCount() {
		TailscaleWatchdog watchdog = watchdog();
		refuse(watchdog, 20);
		assertThat(this.exits).isEmpty();
	}

	@Test
	void sixRefusalsInARowAfterArmingExit() throws IOException {
		TailscaleWatchdog watchdog = watchdog();
		watchdog.record(Probe.CONNECTED);
		refuse(watchdog, 5);
		assertThat(this.exits).isEmpty();
		refuse(watchdog, 1);
		assertThat(this.exits).containsExactly(1);
		assertThat(Files.readAllLines(this.dir.resolve(".watchdog-exits"))).hasSize(1);
	}

	@Test
	void anyOtherResultBreaksTheStreak() {
		TailscaleWatchdog watchdog = watchdog();
		watchdog.record(Probe.CONNECTED);
		refuse(watchdog, 5);
		watchdog.record(Probe.OTHER);
		refuse(watchdog, 5);
		watchdog.record(Probe.CONNECTED);
		refuse(watchdog, 5);
		assertThat(this.exits).isEmpty();
	}

	@Test
	void atMostThreeExitsInTenMinutes() {
		for (int run = 0; run < 3; run++) {
			TailscaleWatchdog watchdog = watchdog();
			watchdog.record(Probe.CONNECTED);
			refuse(watchdog, 6);
			this.clock.advance(Duration.ofMinutes(1));
		}
		assertThat(this.exits).hasSize(3);
		TailscaleWatchdog fourth = watchdog();
		fourth.record(Probe.CONNECTED);
		refuse(fourth, 6);
		assertThat(this.exits).hasSize(3);
		this.clock.advance(Duration.ofMinutes(10));
		refuse(fourth, 6);
		assertThat(this.exits).hasSize(4);
	}

	@Test
	void theLastExitIsReadBackForTheRestartAlert() throws IOException {
		Path exits = this.dir.resolve(".watchdog-exits");
		assertThat(TailscaleWatchdog.lastExit(exits)).isNull();
		TailscaleWatchdog watchdog = watchdog();
		watchdog.record(Probe.CONNECTED);
		refuse(watchdog, 6);
		assertThat(TailscaleWatchdog.lastExit(exits)).isEqualTo(this.clock.instant());
		Files.writeString(exits, "2026-10-16T11:00:00Z\nnot a time\n2026-10-16T11:30:00Z\n");
		assertThat(TailscaleWatchdog.lastExit(exits)).isEqualTo(Instant.parse("2026-10-16T11:30:00Z"));
		assertThat(TailscaleWatchdog.exitsFile(this.dir.resolve("vault"))).isEqualTo(exits.toAbsolutePath());
	}

	@Test
	void probesTellARefusalFromAnAnswer() throws Exception {
		int freePort;
		try (ServerSocket socket = new ServerSocket(0)) {
			freePort = socket.getLocalPort();
		}
		assertThat(watchdog("http://127.0.0.1:" + freePort + "/healthz").probe()).isEqualTo(Probe.REFUSED);
		try (ServerSocket server = new ServerSocket(0)) {
			Thread.ofVirtual().start(() -> {
				try (var client = server.accept()) {
					client.getInputStream().read(new byte[1024]);
					client.getOutputStream()
						.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n".getBytes());
				}
				catch (IOException ex) {
					// The probe has its answer.
				}
			});
			URI url = URI.create("http://127.0.0.1:" + server.getLocalPort() + "/healthz");
			assertThat(watchdog(url.toString()).probe()).isEqualTo(Probe.CONNECTED);
		}
	}

}
