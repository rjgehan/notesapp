package com.rjgehan.notes.watch;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;

import com.rjgehan.notes.api.dto.EntryType;
import com.rjgehan.notes.api.dto.OnConflict;
import com.rjgehan.notes.api.dto.TrashEntry;
import com.rjgehan.notes.api.dto.WatcherMode;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * On Windows the JDK watch service keeps watched folders open, so renaming one fails (JDK-6972833). The watcher
 * therefore starts in polling mode there, and folder moves and deletes keep working.
 */
@EnabledOnOs(OS.WINDOWS)
class VaultWatcherWindowsTest {

	@TempDir
	Path dir;

	@Test
	void anEnabledWatcherPollsAndFoldersCanStillBeTrashed() throws Exception {
		try (TestVault vault = TestVault.start(this.dir)) {
			vault.files.createText("Archive/Sub/x.md", "x", OnConflict.FAIL, TestVault.ALICE, "client-a1");
			RescanScheduler rescans = new RescanScheduler(vault.reconciler);
			rescans.start();
			VaultWatcher watcher = new VaultWatcher(vault.fs, vault.reconciler, rescans, vault.hub, true,
					Duration.ofMillis(50));
			try {
				watcher.start();
				assertThat(watcher.mode()).isEqualTo(WatcherMode.POLLING);

				TrashEntry entry = vault.trash.deleteFolder("Archive", TestVault.ALICE, "client-a1");
				assertThat(entry.type()).isEqualTo(EntryType.FOLDER);
				assertThat(Files.exists(this.dir.resolve("Archive"))).isFalse();
			}
			finally {
				watcher.stop();
				rescans.stop();
			}
		}
	}

}
