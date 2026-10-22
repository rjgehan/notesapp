package com.rjgehan.notes.publish;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vaults.ServerWide;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * The public publish server (ROADMAP item 26, DESIGN §5.28): a JDK {@link HttpServer} on {@code notes.publish.address:port}
 * (default {@code 127.0.0.1:8081}; {@code 0.0.0.0} when the port is published from a container, docs/CASAOS.md),
 * separate from the app's Tomcat, so none of the app's controllers, filters, API or SPA can ever answer on it. It
 * starts only when {@code notes.publish.enabled} is true, and answers only:
 * <ul>
 * <li>{@code GET}/{@code HEAD /p/<slug>}: a published snapshot's page;</li>
 * <li>{@code GET}/{@code HEAD /p/<slug>/<asset>}: an attachment of that snapshot;</li>
 * <li>{@code GET}/{@code HEAD /p/-/style.css}: the stylesheet.</li>
 * </ul>
 * Everything else, any other method included, is {@code 404}. Paths are matched raw (never decoded), so an escaped or
 * dot segment cannot reach anything, and every response forbids scripts, framing and loads from elsewhere.
 */
@Component
@ServerWide
public class PublishServer implements SmartLifecycle {

	private static final Logger logger = LoggerFactory.getLogger(PublishServer.class);

	static final String CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; "
			+ "media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

	private static final Pattern PAGE = Pattern.compile("/p/([a-z0-9-]{1,80})");

	private static final Pattern ASSET = Pattern.compile("/p/([a-z0-9-]{1,80})/([0-9a-f]{20}\\.[a-z0-9]{1,10})");

	private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

	private static final byte[] NOT_FOUND = "Not found\n".getBytes(StandardCharsets.UTF_8);

	private static final byte[] STYLESHEET = PublishPage.STYLESHEET.getBytes(StandardCharsets.UTF_8);

	private final NotesProperties.Publish properties;

	private final PublishService service;

	private final SnapshotStore snapshots;

	private final FileKinds kinds;

	private @Nullable HttpServer server;

	private @Nullable ExecutorService executor;

	public PublishServer(NotesProperties properties, PublishService service, SnapshotStore snapshots,
			FileKinds kinds) {
		this.properties = properties.publish();
		this.service = service;
		this.snapshots = snapshots;
		this.kinds = kinds;
	}

	@Override
	public synchronized void start() {
		if (!this.properties.enabled()) {
			logger.info("Public publishing is off (notes.publish.enabled=false): no publish server");
			return;
		}
		this.service.loadServed();
		try {
			HttpServer http = HttpServer.create(new InetSocketAddress(this.properties.address(), this.properties.port()),
					0);
			http.createContext("/", this::handle);
			this.executor = Executors.newVirtualThreadPerTaskExecutor();
			http.setExecutor(this.executor);
			http.start();
			this.server = http;
			logger.info("Publish server listening on {}:{} (snapshots in {})", this.properties.address(),
					http.getAddress().getPort(), this.snapshots.root());
		}
		catch (IOException ex) {
			throw new IllegalStateException("The publish server cannot listen on " + this.properties.address() + ":"
					+ this.properties.port(), ex);
		}
	}

	@Override
	public synchronized void stop() {
		if (this.server != null) {
			this.server.stop(1);
			this.server = null;
		}
		if (this.executor != null) {
			this.executor.shutdownNow();
			this.executor = null;
		}
	}

	@Override
	public synchronized boolean isRunning() {
		return this.server != null;
	}

	/** The port it listens on, or -1 when it is not running. */
	public synchronized int port() {
		return (this.server != null) ? this.server.getAddress().getPort() : -1;
	}

	void handle(HttpExchange exchange) throws IOException {
		try (exchange) {
			drain(exchange.getRequestBody());
			Headers headers = exchange.getResponseHeaders();
			headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
			headers.set("X-Content-Type-Options", "nosniff");
			headers.set("Referrer-Policy", "no-referrer");
			headers.set("X-Frame-Options", "DENY");
			headers.set("Cross-Origin-Opener-Policy", "same-origin");
			headers.set("Cross-Origin-Resource-Policy", "same-origin");
			headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
			headers.set("X-Robots-Tag", "noindex, nofollow");
			String method = exchange.getRequestMethod();
			boolean head = "HEAD".equals(method);
			String path = exchange.getRequestURI().getRawPath();
			if (!(head || "GET".equals(method)) || path == null) {
				notFound(exchange, head);
				return;
			}
			if (path.equals(PublishPage.STYLESHEET_PATH)) {
				headers.set("Content-Type", "text/css; charset=utf-8");
				headers.set("Cache-Control", "no-cache");
				send(exchange, head, 200, STYLESHEET);
				return;
			}
			Matcher page = PAGE.matcher(path);
			if (page.matches()) {
				serveFile(exchange, head, this.snapshots.page(page.group(1)), "text/html; charset=utf-8", false);
				return;
			}
			Matcher asset = ASSET.matcher(path);
			if (asset.matches()) {
				Path file = this.snapshots.asset(asset.group(1), asset.group(2));
				String type = this.kinds.contentType(asset.group(2)).toString();
				// An attachment opened on its own (an SVG, say) gets a sandbox as well: no script, no same origin.
				headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY + "; sandbox");
				serveFile(exchange, head, file, type, true);
				return;
			}
			notFound(exchange, head);
		}
		catch (IOException ex) {
			logger.debug("Publish server: {}", ex.toString());
		}
	}

	private void serveFile(HttpExchange exchange, boolean head, @Nullable Path file, String type, boolean ranges)
			throws IOException {
		BasicFileAttributes attributes = (file != null) ? attributes(file) : null;
		if (file == null || attributes == null || !attributes.isRegularFile()) {
			notFound(exchange, head);
			return;
		}
		Headers headers = exchange.getResponseHeaders();
		long size = attributes.size();
		String etag = "\"" + Long.toHexString(size) + "-" + Long.toHexString(attributes.lastModifiedTime().toMillis())
				+ "\"";
		headers.set("Content-Type", type);
		headers.set("Cache-Control", "no-cache");
		headers.set("ETag", etag);
		if (ranges) {
			headers.set("Accept-Ranges", "bytes");
		}
		if (etag.equals(exchange.getRequestHeaders().getFirst("If-None-Match"))) {
			exchange.sendResponseHeaders(304, -1);
			return;
		}
		long start = 0;
		long end = size - 1;
		int status = 200;
		String range = ranges ? exchange.getRequestHeaders().getFirst("Range") : null;
		if (range != null && size > 0) {
			Matcher m = RANGE.matcher(range.strip());
			if (m.matches() && !(m.group(1).isEmpty() && m.group(2).isEmpty())) {
				try {
					if (m.group(1).isEmpty()) {
						start = Math.max(0, size - Long.parseLong(m.group(2)));
					}
					else {
						start = Long.parseLong(m.group(1));
						end = m.group(2).isEmpty() ? size - 1 : Math.min(size - 1, Long.parseLong(m.group(2)));
					}
				}
				catch (NumberFormatException ex) {
					start = size;
				}
				if (start > end || start >= size) {
					headers.set("Content-Range", "bytes */" + size);
					exchange.sendResponseHeaders(416, -1);
					return;
				}
				status = 206;
				headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
			}
		}
		long length = (size == 0) ? 0 : end - start + 1;
		if (head) {
			headers.set("Content-Length", Long.toString(length));
			exchange.sendResponseHeaders(status, -1);
			return;
		}
		exchange.sendResponseHeaders(status, (length == 0) ? -1 : length);
		if (length == 0) {
			return;
		}
		try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS);
				OutputStream out = exchange.getResponseBody()) {
			in.skipNBytes(start);
			byte[] buffer = new byte[64 * 1024];
			long remaining = length;
			while (remaining > 0) {
				int n = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
				if (n < 0) {
					break;
				}
				out.write(buffer, 0, n);
				remaining -= n;
			}
		}
	}

	private static @Nullable BasicFileAttributes attributes(Path file) {
		try {
			return Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
		}
		catch (IOException ex) {
			return null;
		}
	}

	private static void notFound(HttpExchange exchange, boolean head) throws IOException {
		exchange.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
		exchange.getResponseHeaders().set("Cache-Control", "no-store");
		send(exchange, head, 404, NOT_FOUND);
	}

	private static void send(HttpExchange exchange, boolean head, int status, byte[] body) throws IOException {
		if (head) {
			exchange.getResponseHeaders().set("Content-Length", Integer.toString(body.length));
			exchange.sendResponseHeaders(status, -1);
			return;
		}
		exchange.sendResponseHeaders(status, body.length);
		try (OutputStream out = exchange.getResponseBody()) {
			out.write(body);
		}
	}

	/** Reads and drops a request body (at most 64 KiB; the connection is closed after a larger one). */
	private static void drain(InputStream body) {
		try (body) {
			body.readNBytes(64 * 1024);
		}
		catch (IOException ex) {
			// The response does not depend on it.
		}
	}

}
