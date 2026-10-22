package com.rjgehan.notes.config;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.Problems;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The app is never reachable through Tailscale Funnel (DESIGN §5.28, ROADMAP item 26): Tailscale's proxy marks every
 * request that arrived from the public internet with {@code Tailscale-Funnel-Request}, and any request carrying that
 * header, whatever its value and path (health included), is refused with {@code 403 funnel-request} before the Host
 * and identity allowlists run. Only the separate publish server (port 8081) may ever be behind Funnel.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class FunnelRequestFilter extends OncePerRequestFilter {

	private static final Logger logger = LoggerFactory.getLogger(FunnelRequestFilter.class);

	public static final String HEADER = "Tailscale-Funnel-Request";

	private final Problems problems;

	public FunnelRequestFilter(Problems problems) {
		this.problems = problems;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		if (request.getHeaders(HEADER).hasMoreElements()) {
			logger.warn("Refused a request that came through Tailscale Funnel: {} {}", request.getMethod(),
					RequestPaths.of(request));
			this.problems.write(request, response,
					new NotesException(ErrorCode.FUNNEL_REQUEST, "NotesApp is not available through Funnel"));
			return;
		}
		chain.doFilter(request, response);
	}

}
