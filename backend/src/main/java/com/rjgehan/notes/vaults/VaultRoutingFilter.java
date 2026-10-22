package com.rjgehan.notes.vaults;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.config.RequestPaths;
import org.jspecify.annotations.Nullable;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The first filter (DESIGN §5.38): a request for {@code /api/v/<name>/rest} continues as a request for
 * {@code /api/rest} that carries the vault's name in {@link #ATTRIBUTE}, so every later filter (admission, size limits,
 * CSRF, security headers) treats it exactly like the same request to the default vault, and
 * {@link VaultDispatchFilter} then hands it to that vault's context. Only a literal, well-formed prefix is rewritten: a
 * path that merely decodes to {@code /api/v/...} (escaped letters, {@code ;} parameters) is left alone and finds no
 * handler, so no spelling of a URL reaches a vault other than the one its prefix names; so is a path with a {@code .}
 * or {@code ..} segment.
 */
@Component
@ServerWide
@Order(Ordered.HIGHEST_PRECEDENCE)
public class VaultRoutingFilter extends OncePerRequestFilter {

	/** The request attribute holding the vault name of a {@code /api/v/<name>/} request. */
	public static final String ATTRIBUTE = VaultRoutingFilter.class.getName() + ".vault";

	private static final Pattern PREFIX = Pattern.compile("/api/v/([a-z0-9-]{1,32})(/[^?#]*)?");

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		String contextPath = request.getContextPath();
		String uri = request.getRequestURI();
		String raw = uri.startsWith(contextPath) ? uri.substring(contextPath.length()) : uri;
		Matcher matcher = PREFIX.matcher(raw);
		if (!matcher.matches() || !VaultNames.isValid(matcher.group(1)) || RequestPaths.hasDotSegment(raw)) {
			chain.doFilter(request, response);
			return;
		}
		String rest = matcher.group(2);
		request.setAttribute(ATTRIBUTE, matcher.group(1));
		chain.doFilter(new Rewritten(request, contextPath + "/api" + ((rest != null) ? rest : "")), response);
	}

	/** The vault name a request was routed to, or null for an unprefixed request. */
	public static @Nullable String vaultOf(HttpServletRequest request) {
		return (request.getAttribute(ATTRIBUTE) instanceof String name) ? name : null;
	}

	/** The request with the vault prefix taken out of its URI. */
	static final class Rewritten extends HttpServletRequestWrapper {

		private final String uri;

		Rewritten(HttpServletRequest request, String uri) {
			super(request);
			this.uri = uri;
		}

		@Override
		public String getRequestURI() {
			return this.uri;
		}

		@Override
		public StringBuffer getRequestURL() {
			StringBuffer url = new StringBuffer();
			url.append(getScheme()).append("://").append(getServerName());
			int port = getServerPort();
			if (port > 0 && !((port == 80 && "http".equals(getScheme())) || (port == 443 && "https".equals(getScheme())))) {
				url.append(':').append(port);
			}
			return url.append(this.uri);
		}

		@Override
		public String getServletPath() {
			return this.uri.substring(getContextPath().length());
		}

		@Override
		public @Nullable String getPathInfo() {
			return null;
		}

	}

}
