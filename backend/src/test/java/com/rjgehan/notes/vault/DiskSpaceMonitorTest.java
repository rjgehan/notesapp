package com.rjgehan.notes.vault;

import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicLong;

import com.rjgehan.notes.events.StatusChangedEvent;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/** Free space crossing {@code min-free-space} (1 GiB) is announced once per crossing, in both directions. */
class DiskSpaceMonitorTest {

	private static final long GIB = 1024L * 1024 * 1024;

	@TempDir
	Path dir;

	private TestVault vault;

	/** The free space the monitor sees; negative means the filesystem cannot be read. */
	private final AtomicLong free = new AtomicLong(10 * GIB);

	private DiskSpaceMonitor monitor;

	@BeforeEach
	void setUp() throws IOException {
		this.vault = TestVault.start(this.dir);
		VaultFs fs = new VaultFs(this.vault.properties) {

			@Override
			public long usableSpace() throws IOException {
				long value = DiskSpaceMonitorTest.this.free.get();
				if (value < 0) {
					throw new IOException("unreadable");
				}
				return value;
			}

		};
		this.monitor = new DiskSpaceMonitor(fs, this.vault.hub, this.vault.properties);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private long diskEvents() {
		return this.vault.hub.published.stream()
			.filter((event) -> event.equals(new StatusChangedEvent(StatusChangedEvent.Reason.DISK)))
			.count();
	}

	@Test
	void eachCrossingIsAnnouncedOnce() {
		this.monitor.check();
		assertThat(this.monitor.isLow()).isFalse();
		assertThat(diskEvents()).isZero();

		this.free.set(GIB - 1);
		this.monitor.check();
		assertThat(this.monitor.isLow()).isTrue();
		assertThat(diskEvents()).isEqualTo(1);
		this.monitor.check();
		assertThat(diskEvents()).isEqualTo(1);

		this.free.set(GIB);
		this.monitor.check();
		assertThat(this.monitor.isLow()).isFalse();
		assertThat(diskEvents()).isEqualTo(2);
	}

	@Test
	void anUnreadableFilesystemChangesNothing() {
		this.free.set(GIB - 1);
		this.monitor.check();
		this.free.set(-1);
		this.monitor.check();
		assertThat(this.monitor.isLow()).isTrue();
		assertThat(diskEvents()).isEqualTo(1);
	}

}
