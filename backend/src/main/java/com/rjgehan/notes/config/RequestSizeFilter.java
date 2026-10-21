package com.rjgehan.notes.config;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;

import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.api.error.PayloadTooLargeException;
import com.rjgehan.notes.api.error.Problems;
import org.jspecify.annotations.Nullable;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Rejects JSON bodies over {@code notes.limits.max-json-body} with {@code 413} before they are read, and cuts off
 * chunked bodies at the same limit while they are read (DESIGN §5.14). Uploads have their own limit and are exempt.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class RequestSizeFilter extends OncePerRequestFilter {

	private static final long ESCAPING_HEADROOM = 64 * 1024;

	private final long limit;

	private final Problems problems;

	public RequestSizeFilter(NotesProperties properties, Problems problems) {
		this.limit = properties.limits().maxJsonBody().toBytes();
		this.problems = problems;
		long largestText = properties.limits()
			.textSizeOverrides()
			.values()
			.stream()
			.mapToLong(DataSize::toBytes)
			.reduce(properties.limits().maxTextSize().toBytes(), Math::max);
		// Escaping can double a text's size in JSON ("\"" and "\\"), so the body limit must leave room for that.
		long required = 2 * largestText + ESCAPING_HEADROOM;
		if (this.limit < required) {
			throw new IllegalStateException("notes.limits.max-json-body (" + this.limit + " bytes) must be at least "
					+ required + " bytes: twice the largest text size limit plus JSON overhead");
		}
	}

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		String path = RequestPaths.of(request);
		return !path.startsWith("/api/") || path.equals("/api/files/raw") || path.equals("/api/attachments")
				|| path.equals("/api/capture/file");
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		if (request.getContentLengthLong() > this.limit) {
			this.problems.write(request, response,
					NotesException.tooLarge(this.limit, "The request body is larger than " + this.limit + " bytes"));
			return;
		}
		chain.doFilter(new LimitedRequest(request, this.limit), response);
	}

	private static final class LimitedRequest extends HttpServletRequestWrapper {

		private final long limit;

		private @Nullable ServletInputStream stream;

		LimitedRequest(HttpServletRequest request, long limit) {
			super(request);
			this.limit = limit;
		}

		@Override
		public ServletInputStream getInputStream() throws IOException {
			if (this.stream == null) {
				this.stream = new LimitedInputStream(super.getInputStream(), this.limit);
			}
			return this.stream;
		}

	}

	private static final class LimitedInputStream extends ServletInputStream {

		private final ServletInputStream delegate;

		private final long limit;

		private long count;

		LimitedInputStream(ServletInputStream delegate, long limit) {
			this.delegate = delegate;
			this.limit = limit;
		}

		@Override
		public int read() throws IOException {
			int b = this.delegate.read();
			if (b >= 0) {
				count(1);
			}
			return b;
		}

		@Override
		public int read(byte[] buffer, int offset, int length) throws IOException {
			int n = this.delegate.read(buffer, offset, length);
			if (n > 0) {
				count(n);
			}
			return n;
		}

		private void count(int n) throws IOException {
			this.count += n;
			if (this.count > this.limit) {
				throw new PayloadTooLargeException(this.limit);
			}
		}

		@Override
		public boolean isFinished() {
			return this.delegate.isFinished();
		}

		@Override
		public boolean isReady() {
			return this.delegate.isReady();
		}

		@Override
		public void setReadListener(ReadListener listener) {
			this.delegate.setReadListener(listener);
		}

	}

}
