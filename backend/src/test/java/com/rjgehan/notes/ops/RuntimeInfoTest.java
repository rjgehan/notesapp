package com.rjgehan.notes.ops;

import java.util.Map;

import com.rjgehan.notes.api.dto.AotCacheState;
import com.rjgehan.notes.api.dto.StatusDetails;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** What the status page says about the JVM and its AOT cache (DESIGN §7.1). */
class RuntimeInfoTest {

	@Test
	void theAotCacheStateComesFromTwoVmFlags() {
		assertThat(RuntimeInfo.aotCacheState(Map.<String, String>of()::get)).isEqualTo(AotCacheState.OFF);
		assertThat(RuntimeInfo.aotCacheState(Map.of("AOTCache", "", "UseSharedSpaces", "true")::get))
			.isEqualTo(AotCacheState.OFF);
		assertThat(RuntimeInfo.aotCacheState(Map.of("AOTCache", "/app/notesapp.aot", "UseSharedSpaces", "true")::get))
			.isEqualTo(AotCacheState.IN_USE);
		assertThat(RuntimeInfo.aotCacheState(Map.of("AOTCache", "/app/notesapp.aot", "UseSharedSpaces", "false")::get))
			.isEqualTo(AotCacheState.NOT_USED);
		assertThat(RuntimeInfo.aotCacheState(Map.of("AOTCache", "/app/notesapp.aot")::get))
			.isEqualTo(AotCacheState.UNKNOWN);
	}

	@Test
	void theRunningJvmIsDescribed() {
		StatusDetails.RuntimeStatus status = new RuntimeInfo().status();
		assertThat(status.javaVersion()).startsWith(String.valueOf(Runtime.version().feature()));
		assertThat(status.heapMaxBytes()).isPositive();
		assertThat(status.heapUsedBytes()).isPositive();
		assertThat(status.processors()).isPositive();
		// The tests run without -XX:AOTCache.
		assertThat(status.aotCache()).isEqualTo(AotCacheState.OFF);
	}

}
