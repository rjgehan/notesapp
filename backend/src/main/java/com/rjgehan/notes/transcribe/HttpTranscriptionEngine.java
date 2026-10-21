package com.rjgehan.notes.transcribe;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.config.NotesProperties.TranscriptionApi;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/**
 * The configured speech-to-text service over HTTP (DESIGN §5.20): a multipart upload of the recording, a JSON answer
 * with its {@code text}. Two protocols, chosen by {@code notes.transcription.api}:
 * <ul>
 * <li>{@code whisper-asr}: whisper-asr-webservice, {@code POST <url>/asr?task=transcribe&output=json&encode=true}
 * with the file in {@code audio_file} (the service converts any format with ffmpeg);</li>
 * <li>{@code openai}: {@code POST <url>/v1/audio/transcriptions} with {@code file}, {@code model} and
 * {@code response_format=json}, and {@code Authorization: Bearer} when a key file is configured.</li>
 * </ul>
 * The file goes as {@code recording.<ext>}: the service needs the format, not the vault's name for it. Redirects are
 * not followed, so a key never goes anywhere but the configured service.
 */
@Component
public class HttpTranscriptionEngine implements TranscriptionEngine {

	private static final int MAX_ERROR_DETAIL = 200;

	private final NotesProperties.Transcription config;

	private final JsonMapper mapper;

	private final HttpClient http;

	public HttpTranscriptionEngine(NotesProperties properties, JsonMapper mapper) {
		this.config = properties.transcription();
		this.mapper = mapper;
		// HTTP/1.1: the Python services answer an h2c upgrade attempt badly or not at all.
		this.http = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(Duration.ofSeconds(10))
			.followRedirects(HttpClient.Redirect.NEVER)
			.build();
	}

	@Override
	public Transcript transcribe(AudioFile audio) throws IOException, InterruptedException {
		String boundary = "notesapp-" + UUID.randomUUID();
		Multipart body = new Multipart(boundary);
		String fileName = "recording" + extensionOf(audio.name());
		if (this.config.api() == TranscriptionApi.OPENAI) {
			body.field("model", this.config.model());
			body.field("response_format", "json");
			if (!this.config.language().isBlank()) {
				body.field("language", this.config.language().strip());
			}
			body.file("file", fileName, audio.contentType(), audio.file());
		}
		else {
			body.file("audio_file", fileName, audio.contentType(), audio.file());
		}
		HttpRequest.Builder request = HttpRequest.newBuilder(endpoint(this.config))
			.timeout(this.config.timeout())
			.header("Content-Type", "multipart/form-data; boundary=" + boundary)
			.header("Accept", "application/json")
			.POST(body.publisher());
		String key = apiKey();
		if (key != null) {
			request.header("Authorization", "Bearer " + key);
		}
		HttpResponse<byte[]> response = this.http.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
		if (response.statusCode() / 100 != 2) {
			String detail = errorDetail(response.body());
			throw new IOException("the service answered HTTP " + response.statusCode()
					+ (detail.isEmpty() ? "" : " (" + detail + ")"));
		}
		JsonNode json;
		try {
			json = this.mapper.readTree(response.body());
		}
		catch (RuntimeException ex) {
			throw new IOException("the service's answer is not JSON");
		}
		JsonNode text = json.get("text");
		if (text == null || !text.isString()) {
			throw new IOException("the service's answer has no text");
		}
		JsonNode language = json.get("language");
		return new Transcript(text.asString().strip(),
				(language != null && language.isString() && !language.asString().isBlank()) ? language.asString()
						: null);
	}

	/** The URL requests go to, from the configured base URL. */
	static URI endpoint(NotesProperties.Transcription config) {
		String base = config.url().strip().replaceAll("/+$", "");
		if (config.api() == TranscriptionApi.OPENAI) {
			return URI.create(base.endsWith("/audio/transcriptions") ? base : base + "/v1/audio/transcriptions");
		}
		StringBuilder url = new StringBuilder(base.endsWith("/asr") ? base : base + "/asr");
		// vad_filter drops silence before decoding (faster-whisper), where Whisper would otherwise invent text.
		url.append("?task=transcribe&output=json&encode=true&vad_filter=true");
		if (!config.language().isBlank()) {
			url.append("&language=").append(URLEncoder.encode(config.language().strip(), StandardCharsets.UTF_8));
		}
		return URI.create(url.toString());
	}

	/** The service's address for the status: scheme, host and port only (no credentials, path or query). */
	static String displayUrl(String url) {
		try {
			URI uri = URI.create(url.strip());
			if (uri.getScheme() == null || uri.getHost() == null) {
				return "(invalid URL)";
			}
			return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() >= 0 ? ":" + uri.getPort() : "");
		}
		catch (IllegalArgumentException ex) {
			return "(invalid URL)";
		}
	}

	/** Read before every request, so a rotated key needs no restart; only for the OpenAI protocol. */
	private @Nullable String apiKey() throws IOException {
		if (this.config.api() != TranscriptionApi.OPENAI || this.config.apiKeyFile().isBlank()) {
			return null;
		}
		String key = Files.readString(Path.of(this.config.apiKeyFile().strip()), StandardCharsets.UTF_8).strip();
		return key.isEmpty() ? null : key;
	}

	/** A short, single-line excerpt of an error answer: FastAPI's {@code detail}, OpenAI's {@code error.message}. */
	private String errorDetail(byte[] body) {
		String text;
		try {
			JsonNode json = this.mapper.readTree(body);
			JsonNode detail = json.has("detail") ? json.get("detail") : json.path("error").get("message");
			text = (detail != null && detail.isString()) ? detail.asString() : new String(body, StandardCharsets.UTF_8);
		}
		catch (RuntimeException ex) {
			text = new String(body, StandardCharsets.UTF_8);
		}
		text = text.replaceAll("\\s+", " ").strip();
		return (text.length() > MAX_ERROR_DETAIL) ? text.substring(0, MAX_ERROR_DETAIL) + "…" : text;
	}

	private static String extensionOf(String name) {
		int dot = name.lastIndexOf('.');
		String ext = (dot >= 0) ? name.substring(dot).toLowerCase(Locale.ROOT) : "";
		return ext.matches("\\.[a-z0-9]{1,8}") ? ext : "";
	}

	/** A {@code multipart/form-data} body whose file part streams from disk. */
	static final class Multipart {

		private final String boundary;

		private final java.util.List<HttpRequest.BodyPublisher> parts = new java.util.ArrayList<>();

		Multipart(String boundary) {
			this.boundary = boundary;
		}

		void field(String name, String value) {
			text("--" + this.boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value
					+ "\r\n");
		}

		void file(String name, String fileName, String contentType, Path file) throws IOException {
			text("--" + this.boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"; filename=\""
					+ fileName + "\"\r\nContent-Type: " + contentType + "\r\n\r\n");
			this.parts.add(HttpRequest.BodyPublishers.ofFile(file));
			text("\r\n");
		}

		HttpRequest.BodyPublisher publisher() {
			text("--" + this.boundary + "--\r\n");
			return HttpRequest.BodyPublishers.concat(this.parts.toArray(HttpRequest.BodyPublisher[]::new));
		}

		private void text(String s) {
			this.parts.add(HttpRequest.BodyPublishers.ofByteArray(s.getBytes(StandardCharsets.UTF_8)));
		}

	}

}
