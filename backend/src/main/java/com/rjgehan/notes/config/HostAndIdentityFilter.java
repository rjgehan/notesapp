package com.rjgehan.notes.config;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.Problems;
import com.rjgehan.notes.identity.Identity;
import com.rjgehan.notes.identity.IdentityResolver;
import com.rjgehan.notes.vaults.ServerWide;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Admission (DESIGN §5.13): the Host allowlist ({@code 421 unknown-host}, which blocks DNS rebinding) and the identity
 * allowlist ({@code 403 identity-not-allowed}) for every request except the health endpoints. The admitted identity
 * is stored as a request attribute, and the client id and a short request id are put in the logging MDC.
 */
@Component
@ServerWide
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class HostAndIdentityFilter extends OncePerRequestFilter {

	private final List<String> allowedHosts;

	private final IdentityResolver identityResolver;

	private final Problems problems;

	public HostAndIdentityFilter(NotesProperties properties, IdentityResolver identityResolver, Problems problems) {
		this.allowedHosts = properties.allowedHosts().stream().map((h) -> h.strip().toLowerCase(Locale.ROOT)).toList();
		this.identityResolver = identityResolver;
		this.problems = problems;
	}

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		String path = RequestPaths.of(request);
		return isHealthPath(path) && !RequestPaths.hasDotSegment(path);
	}

	static boolean isHealthPath(String uri) {
		return uri.equals("/livez") || uri.equals("/readyz") || uri.equals("/actuator/health")
				|| uri.startsWith("/actuator/health/");
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		if (!isAllowedHost(request.getHeader("Host"))) {
			this.problems.write(request, response,
					new NotesException(ErrorCode.UNKNOWN_HOST, "This server does not answer to that host name"));
			return;
		}
		Identity identity = this.identityResolver.resolve(request);
		if (identity == null) {
			this.problems.write(request, response,
					new NotesException(ErrorCode.IDENTITY_NOT_ALLOWED, "This identity may not use NotesApp"));
			return;
		}
		request.setAttribute(Identity.ATTRIBUTE, identity);
		String clientId = request.getHeader("X-Client-Id");
		MDC.put("client", (clientId != null) ? clientId.substring(0, Math.min(8, clientId.length())) : "-");
		MDC.put("request", Problems.newIncidentId().substring(0, 6));
		try {
			chain.doFilter(request, response);
		}
		finally {
			MDC.remove("client");
			MDC.remove("request");
		}
	}

	/**
	 * Entries are {@code host} or {@code host:port}, compared case-insensitively; an entry without a port matches any
	 * port. An empty allowlist (only possible in the dev profile) admits every host.
	 */
	boolean isAllowedHost(@Nullable String hostHeader) {
		if (this.allowedHosts.isEmpty()) {
			return true;
		}
		if (hostHeader == null || hostHeader.isBlank()) {
			return false;
		}
		String host = hostHeader.strip().toLowerCase(Locale.ROOT);
		String hostOnly = hostWithoutPort(host);
		for (String entry : this.allowedHosts) {
			boolean entryHasPort = !hostWithoutPort(entry).equals(entry);
			if (entryHasPort ? entry.equals(host) : entry.equals(hostOnly)) {
				return true;
			}
		}
		return false;
	}

	static String hostWithoutPort(String authority) {
		if (authority.startsWith("[")) {
			int end = authority.indexOf(']');
			return (end > 0) ? authority.substring(0, end + 1) : authority;
		}
		int colon = authority.lastIndexOf(':');
		return (colon >= 0) ? authority.substring(0, colon) : authority;
	}

}
