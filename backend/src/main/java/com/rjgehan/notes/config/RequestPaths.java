package com.rjgehan.notes.config;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.http.server.PathContainer;
import org.springframework.http.server.RequestPath;

/**
 * The path of a request as Spring MVC matches it. Filters that treat {@code /api/**} differently must decide on this
 * path, not on {@link HttpServletRequest#getRequestURI()}: the raw URI keeps {@code ;} path parameters and percent
 * escapes, which Spring's pattern matching strips and decodes, so {@code /api;x=1/files} or {@code /%61pi/files}
 * would reach the {@code /api/files} handler without passing the filters meant for it.
 */
final class RequestPaths {

	private RequestPaths() {
	}

	/** The path within the application, each segment decoded and without its {@code ;} parameters. */
	static String of(HttpServletRequest request) {
		String uri = request.getRequestURI();
		try {
			PathContainer path = RequestPath.parse(uri, request.getContextPath()).pathWithinApplication();
			StringBuilder out = new StringBuilder(uri.length());
			for (PathContainer.Element element : path.elements()) {
				out.append((element instanceof PathContainer.PathSegment segment) ? segment.valueToMatch()
						: element.value());
			}
			return out.toString();
		}
		catch (IllegalArgumentException ex) {
			// Not decodable; the container rejects such URIs before any filter in practice.
			return uri;
		}
	}

	/**
	 * True when a segment is {@code .} or {@code ..}. Spring matches them literally and never resolves them, so no
	 * request for a real resource has one; a path with one must not get an exemption granted by prefix.
	 */
	static boolean hasDotSegment(String path) {
		for (String segment : path.split("/", -1)) {
			if (segment.equals(".") || segment.equals("..")) {
				return true;
			}
		}
		return false;
	}

}
