package com.rjgehan.notes.api;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.Set;

import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.FileService;
import org.jspecify.annotations.Nullable;

import org.springframework.core.io.AbstractResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;

/**
 * Safe serving of user files (DESIGN §5.14 item 6, API.md §9.1): detected content types with HTML, XML and JavaScript
 * never rendered, an inline allowlist, a sandbox CSP (PDF excepted), and caching keyed by size and mtime. Spring
 * handles {@code Range} (206) and conditional requests (304) for these {@link Resource} bodies.
 */
@Component
public class RawResponses {

	static final String SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; "
			+ "style-src 'unsafe-inline'; frame-ancestors 'self'";

	static final String PDF_CSP = "default-src 'none'; frame-ancestors 'self'";

	/** Written literally, in the directive order of API.md §9.1. */
	static final String IMMUTABLE = "private, max-age=31536000, immutable";

	static final String NO_CACHE = "no-cache";

	private final FileKinds kinds;

	public RawResponses(FileKinds kinds) {
		this.kinds = kinds;
	}

	/** A vault file; {@code v} makes the response cacheable forever when it matches the file's size and mtime. */
	public ResponseEntity<Resource> file(FileService.RawFile file, @Nullable String v, boolean download) {
		long mtimeMillis = file.mtime().toEpochMilli();
		String token = file.size() + "-" + mtimeMillis;
		boolean addressed = token.equals(v);
		Resource body = new StreamResource(file.path().name(), file.size(), () -> openNoFollow(file.file()));
		return build(file.path().name(), body, download, addressed ? IMMUTABLE : NO_CACHE,
				"W/\"" + token + "\"", file.mtime());
	}

	/** A blob addressed by commit: always immutable. */
	public ResponseEntity<Resource> blob(String name, String blobId, long size, StreamResource.Opener opener,
			boolean download) {
		return build(name, new StreamResource(name, size, opener), download, IMMUTABLE, "\"" + blobId + "\"", null);
	}

	private ResponseEntity<Resource> build(String name, Resource body, boolean download, String cacheControl,
			String etag, @Nullable Instant lastModified) {
		MediaType type = this.kinds.contentType(name);
		boolean inline = !download && this.kinds.isInline(type);
		boolean pdf = MediaType.APPLICATION_PDF.isCompatibleWith(type);
		ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
			.contentType(type)
			.header(HttpHeaders.CONTENT_DISPOSITION, contentDisposition(inline ? "inline" : "attachment", name))
			.header("Content-Security-Policy", pdf ? PDF_CSP : SANDBOX_CSP)
			.header("X-Content-Type-Options", "nosniff")
			.header("X-Frame-Options", "SAMEORIGIN")
			.header("Cross-Origin-Resource-Policy", "same-origin")
			.header(HttpHeaders.ACCEPT_RANGES, "bytes")
			.header(HttpHeaders.CACHE_CONTROL, cacheControl)
			.eTag(etag);
		if (lastModified != null) {
			builder.lastModified(lastModified);
		}
		return builder.body(body);
	}

	/** {@code inline; filename*=UTF-8''<pct-encoded>} (RFC 6266 with RFC 5987 encoding). */
	static String contentDisposition(String type, String filename) {
		StringBuilder out = new StringBuilder(type).append("; filename*=UTF-8''");
		for (byte b : filename.getBytes(StandardCharsets.UTF_8)) {
			int c = b & 0xFF;
			if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
					|| "!#$&+-.^_`|~".indexOf(c) >= 0) {
				out.append((char) c);
			}
			else {
				out.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
					.append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
			}
		}
		return out.toString();
	}

	private static InputStream openNoFollow(Path file) throws IOException {
		return Channels.newInputStream(
				Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)));
	}

	/** A resource that opens a fresh stream for every read, so multi-range requests work. */
	public static final class StreamResource extends AbstractResource {

		@FunctionalInterface
		public interface Opener {

			InputStream open() throws IOException;

		}

		private final String filename;

		private final long size;

		private final Opener opener;

		StreamResource(String filename, long size, Opener opener) {
			this.filename = filename;
			this.size = size;
			this.opener = opener;
		}

		@Override
		public InputStream getInputStream() throws IOException {
			return this.opener.open();
		}

		@Override
		public long contentLength() {
			return this.size;
		}

		@Override
		public String getFilename() {
			return this.filename;
		}

		@Override
		public boolean exists() {
			return true;
		}

		@Override
		public String getDescription() {
			return "vault file [" + this.filename + "]";
		}

	}

}
