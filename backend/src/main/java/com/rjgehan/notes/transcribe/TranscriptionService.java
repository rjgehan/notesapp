package com.rjgehan.notes.transcribe;

import java.io.IOException;
import java.net.ConnectException;
import java.net.http.HttpTimeoutException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.TranscriptionResult;
import com.rjgehan.notes.api.dto.TranscriptionStatus;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.transcribe.TranscriptionEngine.AudioFile;
import com.rjgehan.notes.transcribe.TranscriptionEngine.Transcript;
import com.rjgehan.notes.vault.FileKinds;
import com.rjgehan.notes.vault.FileService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Transcribes recordings in the vault (DESIGN §5.24, ROADMAP item 33) with the optional speech-to-text service.
 * <ul>
 * <li>Off while {@code notes.transcription.url} is empty: {@code 409 transcription-off}.</li>
 * <li>Only audio and video files ({@code 415 not-audio}) up to {@code notes.transcription.max-size}
 * ({@code 413 too-large}).</li>
 * <li>One recording at a time: the service is usually a CPU on the same small server. A request waits for its turn
 * up to the timeout, then fails ({@code 503 transcription-failed}).</li>
 * <li>A second request for the same version of a file (the phone retrying after it slept) joins the running one, and
 * the last transcripts are kept in memory by path and version, so a retry gets the text without a second run. The
 * text itself goes into the note, by the client; the server stores nothing.</li>
 * <li>The service failing, unreachable or too slow is {@code 503 transcription-failed} with the reason (not 502, which
 * clients take for the proxy during a deploy). Transcripts
 * are never logged.</li>
 * </ul>
 */
@Service
public class TranscriptionService {

	private static final Logger logger = LoggerFactory.getLogger(TranscriptionService.class);

	private static final int KEPT_TRANSCRIPTS = 32;

	private final NotesProperties.Transcription config;

	private final TranscriptionEngine engine;

	private final FileService files;

	private final FileKinds kinds;

	private final Semaphore turn = new Semaphore(1, true);

	private final Map<String, CompletableFuture<Transcript>> running = new ConcurrentHashMap<>();

	private final Map<String, Transcript> kept = new LinkedHashMap<>(16, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Transcript> eldest) {
			return size() > KEPT_TRANSCRIPTS;
		}
	};

	public TranscriptionService(NotesProperties properties, TranscriptionEngine engine, FileService files,
			FileKinds kinds) {
		this.config = properties.transcription();
		this.engine = engine;
		this.files = files;
		this.kinds = kinds;
	}

	public TranscriptionStatus status() {
		if (!this.config.enabled()) {
			return new TranscriptionStatus(false, null, null, this.config.maxSize().toBytes());
		}
		String protocol = (this.config.api() == NotesProperties.TranscriptionApi.OPENAI) ? "openai" : "whisper-asr";
		return new TranscriptionStatus(true, protocol + " at " + HttpTranscriptionEngine.displayUrl(this.config.url()),
				this.config.language().isBlank() ? null : this.config.language().strip(),
				this.config.maxSize().toBytes());
	}

	public TranscriptionResult transcribe(String apiPath) {
		if (!this.config.enabled()) {
			throw new NotesException(ErrorCode.TRANSCRIPTION_OFF,
					"Transcription is off: no transcription service is configured (NOTES_TRANSCRIPTION_URL)");
		}
		FileService.RawFile raw = this.files.openRaw(apiPath);
		String path = raw.path().nfc();
		FileKind kind = this.kinds.kindOf(path);
		if (kind != FileKind.AUDIO && kind != FileKind.VIDEO) {
			throw new NotesException(ErrorCode.NOT_AUDIO, "Only audio and video files can be transcribed",
					Map.of("path", path));
		}
		long max = this.config.maxSize().toBytes();
		if (raw.size() > max) {
			throw NotesException.tooLarge(max, "Recordings larger than " + (max / (1024 * 1024))
					+ " MB are not transcribed (notes.transcription.max-size)");
		}
		String key = path + '\n' + raw.size() + '-' + raw.mtime().toEpochMilli();
		Transcript known;
		synchronized (this.kept) {
			known = this.kept.get(key);
		}
		if (known != null) {
			return new TranscriptionResult(path, known.text(), known.language(), 0);
		}
		CompletableFuture<Transcript> mine = new CompletableFuture<>();
		CompletableFuture<Transcript> other = this.running.putIfAbsent(key, mine);
		long started = System.nanoTime();
		if (other != null) {
			Transcript joined = await(other);
			return new TranscriptionResult(path, joined.text(), joined.language(), elapsed(started));
		}
		try {
			Transcript transcript = run(new AudioFile(raw.path().name(), this.kinds.contentType(path).toString(),
					raw.size(), raw.file()));
			synchronized (this.kept) {
				this.kept.put(key, transcript);
			}
			mine.complete(transcript);
			logger.info("TRANSCRIBE {} {} bytes in {} ms: {} characters", path, raw.size(), elapsed(started),
					transcript.text().length());
			return new TranscriptionResult(path, transcript.text(), transcript.language(), elapsed(started));
		}
		catch (RuntimeException ex) {
			mine.completeExceptionally(ex);
			throw ex;
		}
		finally {
			this.running.remove(key, mine);
		}
	}

	private Transcript run(AudioFile audio) {
		boolean acquired = false;
		try {
			acquired = this.turn.tryAcquire(this.config.timeout().toMillis(), TimeUnit.MILLISECONDS);
			if (!acquired) {
				throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "Other recordings are being transcribed; try again later");
			}
			return this.engine.transcribe(audio);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "The transcription was interrupted; try again");
		}
		catch (IOException ex) {
			logger.warn("TRANSCRIBE_FAILED {}: {}", audio.name(), reason(ex));
			throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "The transcription service failed: " + reason(ex));
		}
		finally {
			if (acquired) {
				this.turn.release();
			}
		}
	}

	private Transcript await(CompletableFuture<Transcript> other) {
		try {
			return other.get(this.config.timeout().toMillis() * 2, TimeUnit.MILLISECONDS);
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "The transcription was interrupted; try again");
		}
		catch (TimeoutException ex) {
			throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "The transcription was interrupted; try again");
		}
		catch (ExecutionException ex) {
			if (ex.getCause() instanceof NotesException notes) {
				throw notes;
			}
			throw new NotesException(ErrorCode.TRANSCRIPTION_FAILED, "The transcription service failed");
		}
	}

	private String reason(IOException ex) {
		if (ex instanceof HttpTimeoutException) {
			return "no answer within " + this.config.timeout().toSeconds() + " s";
		}
		if (ex instanceof ConnectException) {
			return "cannot connect to " + HttpTranscriptionEngine.displayUrl(this.config.url());
		}
		String message = ex.getMessage();
		return (message == null || message.isBlank()) ? ex.getClass().getSimpleName() : message;
	}

	private static long elapsed(long startedNanos) {
		return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
	}

}
