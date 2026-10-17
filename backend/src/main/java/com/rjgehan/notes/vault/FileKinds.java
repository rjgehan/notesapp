package com.rjgehan.notes.vault;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.config.NotesProperties;

import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;

/**
 * Extension to kind (DESIGN §4.2), the per-extension text size limit (§4.4) and the content type rules for serving
 * raw files (§5.14 item 6).
 */
@Component
public class FileKinds {

	private static final Set<String> IMAGE = Set.of("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg");

	private static final Set<String> AUDIO = Set.of("mp3", "m4a", "ogg", "wav", "flac", "3gp");

	private static final Set<String> VIDEO = Set.of("mp4", "mov", "ogv", "webm", "mkv");

	private static final Set<MediaType> INLINE_IMAGES = Set.of(MediaType.IMAGE_PNG, MediaType.IMAGE_JPEG,
			MediaType.IMAGE_GIF, MediaType.parseMediaType("image/webp"), MediaType.parseMediaType("image/avif"),
			MediaType.parseMediaType("image/bmp"), MediaType.parseMediaType("image/svg+xml"));

	private static final Set<String> NEVER_RENDERED = Set.of("text/html", "application/xhtml+xml", "text/xml",
			"application/xml", "text/javascript", "application/javascript", "application/x-javascript",
			"text/ecmascript", "application/ecmascript");

	private static final Map<String, MediaType> OVERRIDES = Map.of("md", MediaType.TEXT_PLAIN, "mjs",
			MediaType.APPLICATION_OCTET_STREAM, "webp", MediaType.parseMediaType("image/webp"), "avif",
			MediaType.parseMediaType("image/avif"), "m4a", MediaType.parseMediaType("audio/mp4"), "mkv",
			MediaType.parseMediaType("video/x-matroska"), "ogv", MediaType.parseMediaType("video/ogg"));

	private final Map<String, FileKind> kinds = new HashMap<>();

	private final long maxTextSize;

	private final Map<String, Long> textSizeOverrides = new HashMap<>();

	public FileKinds(NotesProperties properties) {
		for (String ext : properties.textExtensions()) {
			this.kinds.put(ext.toLowerCase(Locale.ROOT), FileKind.TEXT);
		}
		IMAGE.forEach((ext) -> this.kinds.put(ext, FileKind.IMAGE));
		AUDIO.forEach((ext) -> this.kinds.put(ext, FileKind.AUDIO));
		VIDEO.forEach((ext) -> this.kinds.put(ext, FileKind.VIDEO));
		this.kinds.put("pdf", FileKind.PDF);
		this.kinds.put("md", FileKind.NOTE);
		this.maxTextSize = properties.limits().maxTextSize().toBytes();
		for (Map.Entry<String, DataSize> entry : properties.limits().textSizeOverrides().entrySet()) {
			this.textSizeOverrides.put(entry.getKey().toLowerCase(Locale.ROOT), entry.getValue().toBytes());
		}
	}

	/** The kind of a file name or path, from its lower-cased final extension. */
	public FileKind kindOf(String nameOrPath) {
		return this.kinds.getOrDefault(PathNames.extensionOf(PathNames.nameOf(nameOrPath)), FileKind.OTHER);
	}

	/** True for extensions that map to a kind other than {@code other}. */
	public boolean isKnownExtension(String extension) {
		return this.kinds.containsKey(extension.toLowerCase(Locale.ROOT));
	}

	/** The largest text file, in bytes, that the text API reads, saves and indexes for this name. */
	public long textLimit(String nameOrPath) {
		String ext = PathNames.extensionOf(PathNames.nameOf(nameOrPath));
		return this.textSizeOverrides.getOrDefault(ext, this.maxTextSize);
	}

	/**
	 * The content type for serving a raw file. HTML, XML and JavaScript are never rendered and become
	 * {@code application/octet-stream}; text types carry {@code charset=utf-8}.
	 */
	public MediaType contentType(String name) {
		String ext = PathNames.extensionOf(name);
		MediaType type = OVERRIDES.get(ext);
		if (type == null) {
			type = MediaTypeFactory.getMediaType(name).orElse(MediaType.APPLICATION_OCTET_STREAM);
		}
		String essence = type.getType() + "/" + type.getSubtype();
		boolean xml = type.getSubtype().endsWith("+xml") && !"image/svg+xml".equals(essence);
		if (NEVER_RENDERED.contains(essence) || xml) {
			return MediaType.APPLICATION_OCTET_STREAM;
		}
		if ("text".equals(type.getType())) {
			return new MediaType(type.getType(), type.getSubtype(), StandardCharsets.UTF_8);
		}
		return new MediaType(type.getType(), type.getSubtype());
	}

	/** The inline allowlist of API.md §9.1; everything else is served as an attachment. */
	public boolean isInline(MediaType type) {
		MediaType essence = new MediaType(type.getType(), type.getSubtype());
		return INLINE_IMAGES.contains(essence) || MediaType.APPLICATION_PDF.equals(essence)
				|| "audio".equals(type.getType()) || "video".equals(type.getType())
				|| MediaType.TEXT_PLAIN.equals(essence);
	}

}
