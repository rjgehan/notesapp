package com.rjgehan.notes.config;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ApiGuardInterceptorTest {

	private final ApiGuardInterceptor guard = new ApiGuardInterceptor();

	private static MockHttpServletRequest request(String method) {
		MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/files");
		request.addHeader("Host", "localhost:5173");
		return request;
	}

	private ErrorCode codeOf(MockHttpServletRequest request) {
		try {
			this.guard.preHandle(request, new MockHttpServletResponse(), new Object());
			return null;
		}
		catch (NotesException ex) {
			return ex.code();
		}
	}

	@ParameterizedTest
	@ValueSource(strings = { "GET", "HEAD", "OPTIONS" })
	void safeMethodsNeedNoHeaders(String method) {
		assertThat(codeOf(request(method))).isNull();
	}

	@ParameterizedTest
	@ValueSource(strings = { "POST", "PUT", "PATCH", "DELETE" })
	void mutatingRequestsNeedAClientId(String method) {
		assertThat(codeOf(request(method))).isEqualTo(ErrorCode.CLIENT_ID_REQUIRED);
		MockHttpServletRequest valid = request(method);
		valid.addHeader("X-Client-Id", "c-9a8b7c6d5e4f");
		assertThat(codeOf(valid)).isNull();
	}

	@ParameterizedTest
	@ValueSource(strings = { "short", "has space in it", "under_score1",
			"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })
	void malformedClientIdsAreRejected(String clientId) {
		MockHttpServletRequest request = request("POST");
		request.addHeader("X-Client-Id", clientId);
		assertThat(codeOf(request)).isEqualTo(ErrorCode.CLIENT_ID_REQUIRED);
	}

	@Test
	void originMustMatchHost() {
		MockHttpServletRequest same = request("POST");
		same.addHeader("X-Client-Id", "client-12345");
		same.addHeader("Origin", "http://LOCALHOST:5173");
		assertThat(codeOf(same)).isNull();

		MockHttpServletRequest foreign = request("POST");
		foreign.addHeader("X-Client-Id", "client-12345");
		foreign.addHeader("Origin", "https://evil.example");
		assertThat(codeOf(foreign)).isEqualTo(ErrorCode.CROSS_ORIGIN);

		MockHttpServletRequest nullOrigin = request("POST");
		nullOrigin.addHeader("X-Client-Id", "client-12345");
		nullOrigin.addHeader("Origin", "null");
		assertThat(codeOf(nullOrigin)).isEqualTo(ErrorCode.CROSS_ORIGIN);
	}

	@Test
	void defaultPortsAreEquivalent() {
		assertThat(ApiGuardInterceptor.sameAuthority("https://notes.example.ts.net", "notes.example.ts.net")).isTrue();
		assertThat(ApiGuardInterceptor.sameAuthority("https://notes.example.ts.net", "notes.example.ts.net:443"))
			.isTrue();
		assertThat(ApiGuardInterceptor.sameAuthority("http://localhost:8080", "localhost:5173")).isFalse();
	}

	@Test
	void secFetchSiteMustBeSameOriginOrNone() {
		for (String site : new String[] { "same-origin", "none" }) {
			MockHttpServletRequest request = request("PUT");
			request.addHeader("X-Client-Id", "client-12345");
			request.addHeader("Sec-Fetch-Site", site);
			assertThat(codeOf(request)).isNull();
		}
		for (String site : new String[] { "cross-site", "same-site" }) {
			MockHttpServletRequest request = request("PUT");
			request.addHeader("X-Client-Id", "client-12345");
			request.addHeader("Sec-Fetch-Site", site);
			assertThat(codeOf(request)).isEqualTo(ErrorCode.CROSS_ORIGIN);
		}
	}

	@Test
	void exceptionsCarryProblemCodes() {
		assertThatThrownBy(() -> this.guard.preHandle(request("DELETE"), new MockHttpServletResponse(), new Object()))
			.isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.getBody().getProperties()).containsEntry("code", "client-id-required"));
	}

}
