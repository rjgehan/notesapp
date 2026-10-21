package com.rjgehan.notes.config;

import java.io.IOException;
import java.util.Locale;
import java.util.Set;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Sets the security headers of DESIGN §5.14 on every response, {@code Cache-Control: no-store} on API responses, and
 * {@code X-Notes-Build}. Controllers may override these headers (raw files set their own CSP, frame and caching
 * policy): later writes of the same header replace the default instead of adding a second value.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SecurityHeadersFilter extends OncePerRequestFilter {

	public static final String BUILD_HEADER = "X-Notes-Build";

	/** The service worker script (DESIGN §6.26), built into the static root by the frontend build. */
	static final String SERVICE_WORKER = "/sw.js";

	/** The web app manifest (DESIGN §6.26). */
	static final String MANIFEST = "/manifest.webmanifest";

	/**
	 * {@code 'wasm-unsafe-eval'} lets the app compile its own WebAssembly (PDF.js's JPEG 2000, JBIG2 and colour
	 * decoders, DESIGN §6.8.3); it allows no JavaScript {@code eval}, and the modules can only come from
	 * {@code 'self'}.
	 */
	static final String CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
			+ "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; "
			+ "font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; "
			+ "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'";

	private static final Set<String> OVERRIDABLE = Set.of("content-security-policy", "x-frame-options",
			"cache-control", "cross-origin-resource-policy", "x-content-type-options");

	private final String buildSha;

	public SecurityHeadersFilter(NotesProperties properties) {
		this.buildSha = properties.buildSha();
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		response.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=()");
		response.setHeader(BUILD_HEADER, this.buildSha);
		String path = RequestPaths.of(request);
		if (path.startsWith("/api/") && !setsOwnCaching(path)) {
			response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
		}
		else if (path.equals(SERVICE_WORKER)) {
			// Always revalidated, so a deploy's new worker is found on the next update check; it may control the
			// whole origin (it lives at the root anyway; the header states it).
			response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
			response.setHeader("Service-Worker-Allowed", "/");
		}
		else if (path.equals(MANIFEST)) {
			response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
		}
		chain.doFilter(request, new OverridingHeadersResponse(response));
	}

	/** The raw-file endpoints and the event stream set their own {@code Cache-Control}. */
	static boolean setsOwnCaching(String path) {
		return path.equals("/api/files/raw") || path.equals("/api/history/raw") || path.equals("/api/events")
				|| (path.startsWith("/api/trash/") && path.endsWith("/raw"));
	}

	private static final class OverridingHeadersResponse extends HttpServletResponseWrapper {

		OverridingHeadersResponse(HttpServletResponse response) {
			super(response);
		}

		@Override
		public void addHeader(String name, String value) {
			if (OVERRIDABLE.contains(name.toLowerCase(Locale.ROOT))) {
				super.setHeader(name, value);
			}
			else {
				super.addHeader(name, value);
			}
		}

	}

}
