package com.rjgehan.notes.api.error;

import java.io.IOException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import tools.jackson.databind.json.JsonMapper;

import org.jspecify.annotations.Nullable;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;

/**
 * Renders problems as flat {@code application/problem+json} documents. Serializing a map (rather than
 * {@link ProblemDetail} through Spring's mix-in, which drops empty values) keeps {@code T | null} properties such as
 * {@code currentVersion} present when they are null, as API.md §1.2 requires.
 */
@Component
public class Problems {

	public static final MediaType PROBLEM_JSON = MediaType.APPLICATION_PROBLEM_JSON;

	private final JsonMapper jsonMapper;

	public Problems(JsonMapper jsonMapper) {
		this.jsonMapper = jsonMapper;
	}

	/** The wire form of a problem, with {@code instance} set to the request path. */
	public static Map<String, @Nullable Object> toMap(ProblemDetail problem, @Nullable String instance) {
		Map<String, @Nullable Object> map = new LinkedHashMap<>();
		map.put("type", String.valueOf(problem.getType()));
		map.put("title", problem.getTitle());
		map.put("status", problem.getStatus());
		if (problem.getDetail() != null) {
			map.put("detail", problem.getDetail());
		}
		if (instance != null) {
			map.put("instance", instance);
		}
		else if (problem.getInstance() != null) {
			map.put("instance", problem.getInstance().toString());
		}
		Map<String, @Nullable Object> properties = problem.getProperties();
		if (properties != null) {
			map.putAll(properties);
		}
		return map;
	}

	/** A short random id that ties an error response to its log line. */
	public static String newIncidentId() {
		byte[] bytes = new byte[4];
		ThreadLocalRandom.current().nextBytes(bytes);
		return HexFormat.of().formatHex(bytes);
	}

	/** Writes a problem directly to the servlet response, for filters that run before Spring MVC. */
	public void write(HttpServletRequest request, HttpServletResponse response, NotesException ex) throws IOException {
		response.setStatus(ex.getStatusCode().value());
		response.setContentType(PROBLEM_JSON.toString());
		response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
		ex.getHeaders().forEach((name, values) -> values.forEach((value) -> response.setHeader(name, value)));
		response.getOutputStream().write(this.jsonMapper.writeValueAsBytes(toMap(ex.getBody(), request.getRequestURI())));
	}

}
