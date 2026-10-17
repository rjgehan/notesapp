package com.rjgehan.notes.config;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import com.rjgehan.notes.api.error.Problems;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.identity.IdentityResolver;
import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

class HostAndIdentityFilterTest {

	private static HostAndIdentityFilter filter(Map<String, String> overrides) {
		Map<String, String> properties = new HashMap<>();
		properties.put("notes.allowed-hosts", "notes.example.ts.net,localhost:8080");
		properties.putAll(overrides);
		NotesProperties notes = TestProperties.forVault(Path.of("vault"), properties);
		return new HostAndIdentityFilter(notes, new IdentityResolver(notes), new Problems(JsonMapper.builder().build()));
	}

	private static MockHttpServletRequest request(String uri, String host, String login) {
		MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
		request.setRequestURI(uri);
		request.addHeader("Host", host);
		if (login != null) {
			request.addHeader(IdentityResolver.LOGIN_HEADER, login);
		}
		return request;
	}

	private static MockHttpServletResponse run(HostAndIdentityFilter filter, MockHttpServletRequest request,
			MockFilterChain chain) throws Exception {
		MockHttpServletResponse response = new MockHttpServletResponse();
		filter.doFilter(request, response, chain);
		return response;
	}

	@Test
	void admitsAllowedHostAndIdentity() throws Exception {
		MockFilterChain chain = new MockFilterChain();
		MockHttpServletRequest request = request("/api/tree", "notes.example.ts.net", "rjgehan@github");
		MockHttpServletResponse response = run(filter(Map.of()), request, chain);
		assertThat(response.getStatus()).isEqualTo(200);
		assertThat(chain.getRequest()).isNotNull();
		assertThat(request.getAttribute(Identity.ATTRIBUTE)).isInstanceOf(Identity.class);
	}

	@Test
	void foreignHostGets421() throws Exception {
		MockFilterChain chain = new MockFilterChain();
		MockHttpServletResponse response = run(filter(Map.of()), request("/api/tree", "evil.example", "rjgehan@github"),
				chain);
		assertThat(response.getStatus()).isEqualTo(421);
		assertThat(response.getContentType()).isEqualTo("application/problem+json");
		assertThat(response.getContentAsString()).contains("\"code\":\"unknown-host\"")
			.contains("\"type\":\"urn:notesapp:problem:unknown-host\"");
		assertThat(chain.getRequest()).isNull();
	}

	@Test
	void hostPortRules() {
		HostAndIdentityFilter filter = filter(Map.of());
		assertThat(filter.isAllowedHost("notes.example.ts.net:443")).isTrue();
		assertThat(filter.isAllowedHost("NOTES.example.ts.net")).isTrue();
		assertThat(filter.isAllowedHost("localhost:8080")).isTrue();
		assertThat(filter.isAllowedHost("localhost:9999")).isFalse();
		assertThat(filter.isAllowedHost("localhost")).isFalse();
		assertThat(filter.isAllowedHost("evil.example:8080")).isFalse();
		assertThat(filter.isAllowedHost(null)).isFalse();
	}

	@Test
	void missingLoginGets403UnlessDefaultsAreAllowed() throws Exception {
		MockHttpServletResponse refused = run(filter(Map.of()), request("/api/tree", "localhost:8080", null),
				new MockFilterChain());
		assertThat(refused.getStatus()).isEqualTo(403);
		assertThat(refused.getContentAsString()).contains("\"code\":\"identity-not-allowed\"");

		MockFilterChain chain = new MockFilterChain();
		MockHttpServletResponse admitted = run(filter(Map.of("notes.identity.allow-default", "true")),
				request("/api/tree", "localhost:8080", null), chain);
		assertThat(admitted.getStatus()).isEqualTo(200);
		assertThat(chain.getRequest()).isNotNull();
	}

	@Test
	void loginOutsideTheAllowlistGets403() throws Exception {
		MockHttpServletResponse response = run(filter(Map.of("notes.identity.allowed-logins", "rjgehan@github")),
				request("/", "localhost:8080", "stranger@github"), new MockFilterChain());
		assertThat(response.getStatus()).isEqualTo(403);
	}

	@ParameterizedTest
	@ValueSource(strings = { "/livez", "/readyz", "/actuator/health", "/actuator/health/liveness" })
	void healthPathsAreExemptFromBothChecks(String path) throws Exception {
		MockFilterChain chain = new MockFilterChain();
		MockHttpServletResponse response = run(filter(Map.of()), request(path, "127.0.0.1:8080", null), chain);
		assertThat(response.getStatus()).isEqualTo(200);
		assertThat(chain.getRequest()).isNotNull();
	}

}
