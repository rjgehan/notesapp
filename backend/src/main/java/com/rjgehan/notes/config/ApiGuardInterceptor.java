package com.rjgehan.notes.config;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import org.jspecify.annotations.Nullable;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * CSRF defence for mutating {@code /api/**} requests (DESIGN §5.14 item 4): a well-formed {@code X-Client-Id}, an
 * {@code Origin} whose authority equals the {@code Host}, and a same-origin {@code Sec-Fetch-Site} when present.
 */
@Component
public class ApiGuardInterceptor implements HandlerInterceptor {

	public static final String CLIENT_ID_HEADER = "X-Client-Id";

	private static final Pattern CLIENT_ID = Pattern.compile("[A-Za-z0-9-]{8,64}");

	public static boolean isValidClientId(@Nullable String clientId) {
		return clientId != null && CLIENT_ID.matcher(clientId).matches();
	}

	@Override
	public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
		String method = request.getMethod();
		if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
			return true;
		}
		if (!isValidClientId(request.getHeader(CLIENT_ID_HEADER))) {
			throw new NotesException(ErrorCode.CLIENT_ID_REQUIRED,
					"Mutating requests need an X-Client-Id header of 8 to 64 letters, digits or dashes");
		}
		String origin = request.getHeader("Origin");
		if (origin != null && !sameAuthority(origin, request.getHeader("Host"))) {
			throw new NotesException(ErrorCode.CROSS_ORIGIN, "The request's Origin does not match its Host");
		}
		String fetchSite = request.getHeader("Sec-Fetch-Site");
		if (fetchSite != null && !fetchSite.equalsIgnoreCase("same-origin") && !fetchSite.equalsIgnoreCase("none")) {
			throw new NotesException(ErrorCode.CROSS_ORIGIN, "Cross-site requests are not accepted");
		}
		return true;
	}

	static boolean sameAuthority(String origin, @Nullable String host) {
		if (host == null || origin.equalsIgnoreCase("null")) {
			return false;
		}
		URI uri;
		try {
			uri = URI.create(origin.strip());
		}
		catch (IllegalArgumentException ex) {
			return false;
		}
		if (uri.getHost() == null || uri.getScheme() == null) {
			return false;
		}
		int defaultPort = "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
		String originAuthority = uri.getHost() + ((uri.getPort() >= 0 && uri.getPort() != defaultPort)
				? ":" + uri.getPort() : "");
		String hostAuthority = host.strip();
		if (hostAuthority.endsWith(":" + defaultPort)) {
			hostAuthority = hostAuthority.substring(0, hostAuthority.length() - (":" + defaultPort).length());
		}
		return originAuthority.toLowerCase(Locale.ROOT).equals(hostAuthority.toLowerCase(Locale.ROOT));
	}

}
