package com.rjgehan.notes.tasks;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.support.TestVault;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class UlidTest {

	@Test
	void idsAreUlidsInCreationOrder() {
		TestVault.MutableClock clock = TestVault.newClock();
		Ulid ulid = new Ulid(clock);
		List<String> ids = new ArrayList<>();
		for (int i = 0; i < 1000; i++) {
			ids.add(ulid.next());
			if (i % 100 == 0) {
				clock.advance(Duration.ofMillis(1));
			}
		}
		assertThat(ids).allMatch((id) -> Ulid.PATTERN.matcher(id).matches()).isSorted().doesNotHaveDuplicates();
		// 2026-10-16T12:00:00Z is 1792152000000 ms: the timestamp is the first ten characters.
		assertThat(ids.get(0)).startsWith("01M529ANG0");
	}

	@Test
	void aClockGoingBackwardsKeepsIdsIncreasing() {
		TestVault.MutableClock clock = TestVault.newClock();
		Ulid ulid = new Ulid(clock);
		String first = ulid.next();
		clock.advance(Duration.ofSeconds(-10));
		assertThat(ulid.next()).isGreaterThan(first);
	}

}
