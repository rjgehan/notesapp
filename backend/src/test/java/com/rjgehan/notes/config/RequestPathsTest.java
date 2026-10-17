package com.rjgehan.notes.config;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class RequestPathsTest {

	@ParameterizedTest
	@CsvSource({ "/api/files, /api/files", "/api;x=1/files, /api/files", "/api;jsessionid=x/files;a=b, /api/files",
			"/%61pi/tree, /api/tree", "/n/Some%20Note.md, /n/Some Note.md", "/actuator/health/..;/x, /actuator/health/../x" })
	void thePathIsWhatSpringMvcMatches(String uri, String path) {
		assertThat(RequestPaths.of(new MockHttpServletRequest("GET", uri))).isEqualTo(path);
	}

	@Test
	void dotSegmentsAreDetected() {
		assertThat(RequestPaths.hasDotSegment("/actuator/health/../x")).isTrue();
		assertThat(RequestPaths.hasDotSegment("/actuator/health/./x")).isTrue();
		assertThat(RequestPaths.hasDotSegment("/actuator/health/liveness")).isFalse();
		assertThat(RequestPaths.hasDotSegment("/n/a..b.md")).isFalse();
	}

	@Test
	void queryParametersComeFromTheQueryStringOnly() {
		MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/attachments");
		request.setQueryString("name=a+b%2B.png&source=Daily%2F1.md&flag&bad=%zz&name=second");
		request.setContentType("application/x-www-form-urlencoded");
		request.setContent("name=from-the-body".getBytes());
		request.addParameter("name", "from-the-body");
		QueryParametersFilter.QueryParametersRequest wrapped = new QueryParametersFilter.QueryParametersRequest(
				request);
		assertThat(wrapped.getParameter("name")).isEqualTo("a b+.png");
		assertThat(wrapped.getParameterValues("name")).containsExactly("a b+.png", "second");
		assertThat(wrapped.getParameter("source")).isEqualTo("Daily/1.md");
		assertThat(wrapped.getParameter("flag")).isEmpty();
		assertThat(wrapped.getParameter("bad")).isNull();
		assertThat(wrapped.getParameterMap()).containsOnlyKeys("name", "source", "flag");
		assertThat(QueryParametersFilter.QueryParametersRequest.parse(null)).isEqualTo(Map.of());
	}

}
