package com.rjgehan.notes.transcribe;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.support.TestProperties;
import com.rjgehan.notes.transcribe.TranscriptionEngine.AudioFile;
import com.rjgehan.notes.transcribe.TranscriptionEngine.Transcript;
import com.sun.net.httpserver.HttpServer;
import tools.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The HTTP side of transcription (DESIGN §5.24) against a stand-in service: both protocols' requests (path, query,
 * multipart fields, the file streamed as {@code recording.<ext>}, the key), the parsed answer, and errors.
 */
class HttpTranscriptionEngineTest {

	record Received(String method, String uri, Map<String, List<String>> headers, byte[] body) {

		String header(String name) {
			List<String> values = this.headers.get(name);
			return (values == null) ? null : values.getFirst();
		}

		String text() {
			return new String(this.body, StandardCharsets.ISO_8859_1);
		}

	}

	@TempDir
	Path dir;

	HttpServer server;

	final List<Received> received = new CopyOnWriteArrayList<>();

	volatile int status = 200;

	volatile String answer = "{\"text\":\" Hello from the stand-in. \",\"language\":\"en\",\"segments\":[]}";

	volatile long delayMillis;

	Path audio;

	@BeforeEach
	void start() throws IOException {
		this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
		this.server.createContext("/", (exchange) -> {
			Map<String, List<String>> headers = new HashMap<>();
			exchange.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(), values));
			this.received.add(new Received(exchange.getRequestMethod(), exchange.getRequestURI().toString(), headers,
					exchange.getRequestBody().readAllBytes()));
			try {
				Thread.sleep(this.delayMillis);
			}
			catch (InterruptedException ex) {
				Thread.currentThread().interrupt();
			}
			byte[] bytes = this.answer.getBytes(StandardCharsets.UTF_8);
			exchange.getResponseHeaders().add("Content-Type", "application/json");
			exchange.sendResponseHeaders(this.status, bytes.length);
			exchange.getResponseBody().write(bytes);
			exchange.close();
		});
		this.server.start();
		this.audio = Files.write(this.dir.resolve("Recording 20261021143000.m4a"), new byte[] { 0, 1, 2, 'a', 'u', 'd' });
	}

	@AfterEach
	void stop() {
		this.server.stop(0);
	}

	private String base() {
		return "http://127.0.0.1:" + this.server.getAddress().getPort();
	}

	private HttpTranscriptionEngine engine(Map<String, String> overrides) {
		Map<String, String> properties = new HashMap<>(Map.of("notes.transcription.url", base()));
		properties.putAll(overrides);
		NotesProperties notes = TestProperties.forVault(this.dir, properties);
		return new HttpTranscriptionEngine(notes, JsonMapper.builder().build());
	}

	private AudioFile file() throws IOException {
		return new AudioFile("Recording 20261021143000.m4a", "audio/mp4", Files.size(this.audio), this.audio);
	}

	@Test
	void whisperAsrPostsTheRecordingToAsrAndReadsItsText() throws Exception {
		Transcript transcript = engine(Map.of("notes.transcription.language", "de")).transcribe(file());

		assertThat(transcript).isEqualTo(new Transcript("Hello from the stand-in.", "en"));
		Received request = this.received.getFirst();
		assertThat(request.method()).isEqualTo("POST");
		assertThat(request.uri())
			.isEqualTo("/asr?task=transcribe&output=json&encode=true&vad_filter=true&language=de");
		assertThat(request.header("content-type")).startsWith("multipart/form-data; boundary=notesapp-");
		assertThat(request.header("authorization")).isNull();
		String boundary = request.header("content-type").substring("multipart/form-data; boundary=".length());
		assertThat(request.text()).isEqualTo("--" + boundary + "\r\n"
				+ "Content-Disposition: form-data; name=\"audio_file\"; filename=\"recording.m4a\"\r\n"
				+ "Content-Type: audio/mp4\r\n\r\n" + "\u0000\u0001\u0002aud" + "\r\n--" + boundary + "--\r\n");
	}

	@Test
	void theOpenAiProtocolSendsModelFormatLanguageAndTheKeyFromItsFile() throws Exception {
		Path key = Files.writeString(this.dir.resolve("transcription-key"), "  sk-test-123\n");
		HttpTranscriptionEngine engine = engine(Map.of("notes.transcription.api", "openai",
				"notes.transcription.model", "Systran/faster-whisper-small", "notes.transcription.language", "fr",
				"notes.transcription.api-key-file", key.toString()));
		this.answer = "{\"text\":\"Bonjour.\"}";

		assertThat(engine.transcribe(file())).isEqualTo(new Transcript("Bonjour.", null));
		Received request = this.received.getFirst();
		assertThat(request.uri()).isEqualTo("/v1/audio/transcriptions");
		assertThat(request.header("authorization")).isEqualTo("Bearer sk-test-123");
		assertThat(request.text()).contains("name=\"model\"\r\n\r\nSystran/faster-whisper-small\r\n")
			.contains("name=\"response_format\"\r\n\r\njson\r\n")
			.contains("name=\"language\"\r\n\r\nfr\r\n")
			.contains("name=\"file\"; filename=\"recording.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n");
		// A rotated key is read on the next request.
		Files.writeString(key, "sk-new");
		engine.transcribe(file());
		assertThat(this.received.get(1).header("authorization")).isEqualTo("Bearer sk-new");
	}

	@Test
	void endpointsAcceptBaseUrlsWithOrWithoutTheirPath() {
		NotesProperties.Transcription asr = TestProperties
			.forVault(this.dir, Map.of("notes.transcription.url", "http://whisper:9000/"))
			.transcription();
		assertThat(HttpTranscriptionEngine.endpoint(asr))
			.hasToString("http://whisper:9000/asr?task=transcribe&output=json&encode=true&vad_filter=true");
		NotesProperties.Transcription asrPath = TestProperties
			.forVault(this.dir, Map.of("notes.transcription.url", "http://whisper:9000/asr"))
			.transcription();
		assertThat(HttpTranscriptionEngine.endpoint(asrPath).getPath()).isEqualTo("/asr");
		NotesProperties.Transcription openai = TestProperties
			.forVault(this.dir, Map.of("notes.transcription.url", "https://api.example.com/v1/audio/transcriptions",
					"notes.transcription.api", "openai"))
			.transcription();
		assertThat(HttpTranscriptionEngine.endpoint(openai)).hasToString("https://api.example.com/v1/audio/transcriptions");
		assertThat(openai.api()).isEqualTo(NotesProperties.TranscriptionApi.OPENAI);
		NotesProperties.Transcription defaults = TestProperties.forVault(this.dir).transcription();
		assertThat(defaults.enabled()).isFalse();
		assertThat(defaults.api()).isEqualTo(NotesProperties.TranscriptionApi.WHISPER_ASR);
		assertThat(defaults.maxSize().toMegabytes()).isEqualTo(25);
		assertThat(defaults.timeout().toMinutes()).isEqualTo(10);
	}

	@Test
	void theStatusShowsTheServiceWithoutCredentialsPathOrQuery() {
		assertThat(HttpTranscriptionEngine.displayUrl("http://user:secret@notesapp-whisper:9000/base?key=x"))
			.isEqualTo("http://notesapp-whisper:9000");
		assertThat(HttpTranscriptionEngine.displayUrl("https://api.example.com/v1")).isEqualTo("https://api.example.com");
		assertThat(HttpTranscriptionEngine.displayUrl("not a url")).isEqualTo("(invalid URL)");
	}

	@Test
	void errorsNameTheStatusAndTheServicesShortReason() {
		HttpTranscriptionEngine engine = engine(Map.of());
		this.status = 500;
		this.answer = "{\"detail\":\"Model base could not be\\n loaded\"}";
		assertThatThrownBy(() -> engine.transcribe(file())).isInstanceOf(IOException.class)
			.hasMessage("the service answered HTTP 500 (Model base could not be loaded)");
		this.status = 401;
		this.answer = "{\"error\":{\"message\":\"Incorrect API key\"}}";
		assertThatThrownBy(() -> engine.transcribe(file())).hasMessage("the service answered HTTP 401 (Incorrect API key)");
		this.status = 200;
		this.answer = "<html>proxy</html>";
		assertThatThrownBy(() -> engine.transcribe(file())).hasMessage("the service's answer is not JSON");
		this.answer = "{\"segments\":[]}";
		assertThatThrownBy(() -> engine.transcribe(file())).hasMessage("the service's answer has no text");
	}

	@Test
	void aServiceSlowerThanTheTimeoutFails() {
		this.delayMillis = 2000;
		assertThatThrownBy(() -> engine(Map.of("notes.transcription.timeout", "300ms")).transcribe(file()))
			.isInstanceOf(HttpTimeoutException.class);
	}

}
