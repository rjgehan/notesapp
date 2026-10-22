package com.rjgehan.notes.config;

import java.util.List;

import org.junit.jupiter.api.Test;

import org.springframework.core.annotation.Order;

import static org.assertj.core.api.Assertions.assertThat;

/** Funnel traffic is refused before any filter but the security headers looks at the request (DESIGN §5.28). */
class FilterOrderTest {

	private static int order(Class<?> filter) {
		return filter.getAnnotation(Order.class).value();
	}

	@Test
	void theFunnelFilterRunsRightAfterTheSecurityHeaders() {
		int funnel = order(FunnelRequestFilter.class);
		assertThat(order(SecurityHeadersFilter.class)).isLessThan(funnel);
		for (Class<?> later : List.of(QueryParametersFilter.class, HostAndIdentityFilter.class, RequestSizeFilter.class)) {
			assertThat(order(later)).as(later.getSimpleName()).isGreaterThan(funnel);
		}
	}
}
