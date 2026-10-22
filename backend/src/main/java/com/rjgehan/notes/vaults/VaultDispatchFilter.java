package com.rjgehan.notes.vaults;

import java.io.IOException;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.Problems;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * The last filter (DESIGN §5.39): a request {@link VaultRoutingFilter} routed to an extra vault is served by that
 * vault's dispatcher instead of the main one, after every other filter has admitted it. It runs for asynchronous and
 * error dispatches too, so an event stream's completion and an error page reach the same vault's context.
 */
@Component
@ServerWide
@Order(Ordered.LOWEST_PRECEDENCE)
public class VaultDispatchFilter extends OncePerRequestFilter {

	private final VaultRegistry registry;

	private final Problems problems;

	public VaultDispatchFilter(VaultRegistry registry, Problems problems) {
		this.registry = registry;
		this.problems = problems;
	}

	@Override
	protected boolean shouldNotFilterAsyncDispatch() {
		return false;
	}

	@Override
	protected boolean shouldNotFilterErrorDispatch() {
		return false;
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		String vault = VaultRoutingFilter.vaultOf(request);
		if (vault == null || this.registry.isDefault(vault)) {
			chain.doFilter(request, response);
			return;
		}
		jakarta.servlet.Servlet servlet;
		try {
			servlet = this.registry.dispatcher(vault);
		}
		catch (NotesException ex) {
			if (request.getDispatcherType() != DispatcherType.REQUEST || response.isCommitted()) {
				throw ex;
			}
			this.problems.write(request, response, ex);
			return;
		}
		servlet.service(request, response);
	}

}
