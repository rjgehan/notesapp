package com.rjgehan.notes.config;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The clipper page keeps its opener policy in an extra vault too (DESIGN §5.39). */
class VaultPathHeadersTest {

	@Test
	void theClipPageOfAnyVaultIsTheClipPage() {
		assertThat(SecurityHeadersFilter.isClipPage("/clip")).isTrue();
		assertThat(SecurityHeadersFilter.isClipPage("/v/work/clip")).isTrue();
		assertThat(SecurityHeadersFilter.isClipPage("/v/work/x/clip")).isFalse();
		assertThat(SecurityHeadersFilter.isClipPage("/n/clip")).isFalse();
		assertThat(SecurityHeadersFilter.isClipPage("/v/clip")).isFalse();
	}

}
