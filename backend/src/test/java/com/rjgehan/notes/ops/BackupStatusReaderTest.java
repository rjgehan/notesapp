package com.rjgehan.notes.ops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import com.rjgehan.notes.api.dto.BackupState;
import com.rjgehan.notes.api.dto.BackupStatus;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/** The backup run's {@code status.json} (DESIGN §7.10) as the status page shows it. */
class BackupStatusReaderTest {

	@TempDir
	Path dir;

	private final TestVault.MutableClock clock = TestVault.newClock();

	private BackupStatusReader reader() {
		return new BackupStatusReader(TestProperties.forVault(this.dir.resolve("vault"),
				Map.of("notes.backup.status-file", this.dir.resolve("status.json").toString())), this.clock,
				JsonMapper.builder().build());
	}

	private void write(String json) throws IOException {
		Files.writeString(this.dir.resolve("status.json"), json);
	}

	/** What nightly.sh writes, with the times relative to the test clock. */
	private String status(String result, Duration lastRunAgo, Duration lastSuccessAgo, String failures) {
		Instant now = this.clock.instant();
		return """
				{"lastRun":"%s","result":"%s","snapshot":"4f1c2a9b","offsite":"ok","lastSuccess":"%s","failures":%s}
				""".formatted(now.minus(lastRunAgo), result, now.minus(lastSuccessAgo), failures);
	}

	@Test
	void withoutTheFileTheStateIsUnknown() {
		BackupStatus status = reader().read();
		assertThat(status.state()).isEqualTo(BackupState.UNKNOWN);
		assertThat(status.reason()).contains("not set up");
		assertThat(status.lastRun()).isNull();
	}

	@Test
	void aRecentGoodRunIsOk() throws IOException {
		write(status("ok", Duration.ofHours(8), Duration.ofHours(8), "null"));
		BackupStatus status = reader().read();
		assertThat(status.state()).isEqualTo(BackupState.OK);
		assertThat(status.reason()).isNull();
		assertThat(status.lastRun()).isEqualTo(this.clock.instant().minus(Duration.ofHours(8)));
		assertThat(status.lastSuccess()).isEqualTo(status.lastRun());
		assertThat(status.snapshot()).isEqualTo("4f1c2a9b");
		assertThat(status.offsite()).isEqualTo("ok");
		assertThat(status.failures()).isNull();
	}

	@Test
	void aFailedRunIsFailedWithItsSteps() throws IOException {
		write(status("failed", Duration.ofHours(2), Duration.ofHours(26), "\"- off-site copy: Fatal: unable to open\\u0007 \""));
		BackupStatus status = reader().read();
		assertThat(status.state()).isEqualTo(BackupState.FAILED);
		assertThat(status.failures()).isEqualTo("- off-site copy: Fatal: unable to open");
	}

	@Test
	void aFailureCutInsideAUtf8CharacterOrWithARawControlCharacterIsStillAFailure() throws IOException {
		// nightly.sh cuts restic's output at 300 bytes: here in the middle of "é" (C3 A9), leaving a lone C3 byte,
		// and an ESC (1B) from a terminal colour code is written unescaped.
		String json = status("failed", Duration.ofHours(2), Duration.ofHours(26),
				"\"- snapshot (restic exit 3): error: open /source/notes-data/vault/Caf\u0001\u001B[0m \"");
		byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
		int cut = json.indexOf('\u0001');
		bytes[cut] = (byte) 0xC3;
		Files.write(this.dir.resolve("status.json"), bytes);
		BackupStatus status = reader().read();
		assertThat(status.state()).isEqualTo(BackupState.FAILED);
		assertThat(status.failures()).startsWith("- snapshot (restic exit 3): error: open /source/notes-data/vault/Caf�")
			.doesNotContain("\u001B");
	}

	@Test
	void runsThatStoppedAreStale() throws IOException {
		write(status("ok", Duration.ofHours(37), Duration.ofHours(37), "null"));
		assertThat(reader().read().state()).isEqualTo(BackupState.STALE);
		write("{\"lastRun\":\"" + this.clock.instant() + "\",\"result\":\"ok\",\"lastSuccess\":null}");
		assertThat(reader().read().state()).isEqualTo(BackupState.STALE);
	}

	@Test
	void aDamagedFileIsUnknownNotAnError() throws IOException {
		write("{\"lastRun\": ");
		assertThat(reader().read().state()).isEqualTo(BackupState.UNKNOWN);
		assertThat(reader().read().reason()).isEqualTo("The backup status file is not valid JSON");
		write("[]");
		assertThat(reader().read().reason()).isEqualTo("The backup status file is not a JSON object");
		write("{\"lastRun\":\"yesterday\",\"result\":42,\"lastSuccess\":\"" + this.clock.instant() + "\"}");
		BackupStatus odd = reader().read();
		assertThat(odd.state()).isEqualTo(BackupState.OK);
		assertThat(odd.lastRun()).isNull();
		Files.delete(this.dir.resolve("status.json"));
		Files.createDirectory(this.dir.resolve("status.json"));
		assertThat(reader().read().state()).isEqualTo(BackupState.UNKNOWN);
	}

}
