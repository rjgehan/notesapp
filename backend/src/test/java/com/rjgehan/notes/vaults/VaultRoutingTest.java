package com.rjgehan.notes.vaults;

import java.util.ArrayList;
import java.util.List;

import jakarta.servlet.http.HttpServletRequest;

import org.junit.jupiter.api.Test;

import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

/** Vault names and the {@code /api/v/<name>/} rewrite (DESIGN §5.39). */
class VaultRoutingTest {

	@Test
	void vaultNamesAreLowercaseUrlSafeFolderNames() {
		assertThat(VaultNames.isValid("work")).isTrue();
		assertThat(VaultNames.isValid("a")).isTrue();
		assertThat(VaultNames.isValid("my-vault-2")).isTrue();
		assertThat(VaultNames.isValid("a".repeat(32))).isTrue();
		assertThat(VaultNames.isValid("a".repeat(33))).isFalse();
		assertThat(VaultNames.isValid("Work")).isFalse();
		assertThat(VaultNames.isValid("-work")).isFalse();
		assertThat(VaultNames.isValid("work-")).isFalse();
		assertThat(VaultNames.isValid(".")).isFalse();
		assertThat(VaultNames.isValid("..")).isFalse();
		assertThat(VaultNames.isValid("a b")).isFalse();
		assertThat(VaultNames.isValid("")).isFalse();
		assertThat(VaultNames.isValid(null)).isFalse();
		assertThat(VaultNames.urlPrefix("work", false)).isEqualTo("/v/work");
		assertThat(VaultNames.urlPrefix("main", true)).isEmpty();
	}

	private record Routed(String uri, String servletPath, Object vault) {
	}

	private static Routed route(String uri) throws Exception {
		MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
		request.setServletPath(uri);
		List<Routed> seen = new ArrayList<>();
		new VaultRoutingFilter().doFilter(request, new MockHttpServletResponse(), new MockFilterChain() {

			@Override
			public void doFilter(jakarta.servlet.ServletRequest req, jakarta.servlet.ServletResponse res) {
				HttpServletRequest http = (HttpServletRequest) req;
				seen.add(new Routed(http.getRequestURI(), http.getServletPath(), http.getAttribute(VaultRoutingFilter.ATTRIBUTE)));
			}

		});
		return seen.get(0);
	}

	@Test
	void aWellFormedPrefixIsTakenOutOfTheUri() throws Exception {
		assertThat(route("/api/v/work/files")).isEqualTo(new Routed("/api/files", "/api/files", "work"));
		assertThat(route("/api/v/work/trash/abc/raw")).isEqualTo(new Routed("/api/trash/abc/raw", "/api/trash/abc/raw", "work"));
		assertThat(route("/api/v/work")).isEqualTo(new Routed("/api", "/api", "work"));
		assertThat(route("/api/v/main/tree")).isEqualTo(new Routed("/api/tree", "/api/tree", "main"));
	}

	@Test
	void anythingElseIsLeftAlone() throws Exception {
		for (String uri : List.of("/api/files", "/api/vaults", "/v/work/n/Note.md", "/api/v/Work/files", "/api/v/-x/files",
				"/api/v/%77ork/files", "/api/v/work;x=1/files", "/api/v/work/../files", "/api/v/work/./files",
				"/api/v/" + "a".repeat(33) + "/files", "/api/vx/work/files")) {
			Routed routed = route(uri);
			assertThat(routed.uri()).as(uri).isEqualTo(uri);
			assertThat(routed.vault()).as(uri).isNull();
		}
	}

}
