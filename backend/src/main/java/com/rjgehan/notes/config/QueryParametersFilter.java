package com.rjgehan.notes.config;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

import org.jspecify.annotations.Nullable;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Request parameters come from the query string only. No endpoint takes form fields, and upload bodies are raw bytes
 * with any {@code Content-Type} (API.md §1.2), including curl's default {@code application/x-www-form-urlencoded}.
 * If looking up {@code ?name=} let the container parse such a body as form fields, the upload would then read an
 * empty stream and store an empty file, and the parse would buffer the body without any size limit. With Spring's
 * {@code FormContentFilter} switched off ({@code spring.mvc.formcontent.filter.enabled=false}), no request body is
 * ever read as a form.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class QueryParametersFilter extends OncePerRequestFilter {

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		chain.doFilter(new QueryParametersRequest(request), response);
	}

	@Override
	protected boolean shouldNotFilterAsyncDispatch() {
		return false;
	}

	@Override
	protected boolean shouldNotFilterErrorDispatch() {
		return false;
	}

	/** A request whose parameters are parsed from its query string alone, like a form-decoded query. */
	static final class QueryParametersRequest extends HttpServletRequestWrapper {

		private @Nullable Map<String, String[]> parameters;

		QueryParametersRequest(HttpServletRequest request) {
			super(request);
		}

		@Override
		public @Nullable String getParameter(String name) {
			String[] values = getParameterMap().get(name);
			return (values != null) ? values[0] : null;
		}

		@Override
		public Map<String, String[]> getParameterMap() {
			if (this.parameters == null) {
				this.parameters = parse(getQueryString());
			}
			return this.parameters;
		}

		@Override
		public Enumeration<String> getParameterNames() {
			return Collections.enumeration(getParameterMap().keySet());
		}

		@Override
		public String @Nullable [] getParameterValues(String name) {
			String[] values = getParameterMap().get(name);
			return (values != null) ? values.clone() : null;
		}

		/** {@code a=1&b&a=2}, with {@code +} as a space; a pair that is not valid percent-encoding is ignored. */
		static Map<String, String[]> parse(@Nullable String query) {
			Map<String, List<String>> values = new LinkedHashMap<>();
			if (query != null && !query.isEmpty()) {
				for (String pair : query.split("&")) {
					if (pair.isEmpty()) {
						continue;
					}
					int equals = pair.indexOf('=');
					try {
						String name = URLDecoder.decode((equals < 0) ? pair : pair.substring(0, equals),
								StandardCharsets.UTF_8);
						String value = (equals < 0) ? ""
								: URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8);
						values.computeIfAbsent(name, (key) -> new ArrayList<>()).add(value);
					}
					catch (IllegalArgumentException ex) {
						// Malformed escapes: ignored, as the container does.
					}
				}
			}
			Map<String, String[]> parsed = new LinkedHashMap<>();
			values.forEach((name, list) -> parsed.put(name, list.toArray(new String[0])));
			return Collections.unmodifiableMap(parsed);
		}

	}

}
