package com.rjgehan.notes.config;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import jakarta.validation.constraints.NotNull;

import org.jspecify.annotations.Nullable;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

/**
 * The {@code notes.*} configuration tree (DESIGN §5.16).
 */
@ConfigurationProperties("notes")
@Validated
public record NotesProperties(
		@NotNull Path vaultDir,
		@DefaultValue List<String> allowedHosts,
		@DefaultValue Git git,
		@DefaultValue Watcher watcher,
		@DefaultValue Sse sse,
		@DefaultValue Limits limits,
		@DefaultValue Identity identity,
		@DefaultValue Security security,
		@DefaultValue TailscaleWatchdog tailscaleWatchdog,
		@DefaultValue Mirror mirror,
		@DefaultValue Alerts alerts,
		@DefaultValue Backup backup,
		@DefaultValue Transcription transcription,
		@DefaultValue("/data/secrets") Path secretsDir,
		@DefaultValue Tasks tasks,
		@DefaultValue Search search,
		@DefaultValue Publish publish,
		@DefaultValue Vaults vaults,
		@DefaultValue({ "md", "markdown", "txt", "json", "canvas", "excalidraw", "sheet", "tasks", "csv", "tsv", "yaml",
				"yml", "mdenc" }) List<String> textExtensions,
		@DefaultValue("true") boolean welcomeNote,
		@DefaultValue("dev") String buildSha) {

	/**
	 * {@code largeFileThreshold}: files larger than this stay in the vault but out of git history (DESIGN §5.8,
	 * ROADMAP item 23); {@code 0} versions every file.
	 */
	public record Git(
			@DefaultValue("true") boolean enabled,
			@DefaultValue("30s") Duration commitQuietPeriod,
			@DefaultValue("5m") Duration commitMaxDelay,
			@DefaultValue("NotesApp") String committerName,
			@DefaultValue("notesapp@notes") String committerEmail,
			@DefaultValue("0 30 3 * * *") String gcCron,
			@DefaultValue("25MB") DataSize largeFileThreshold) {
	}

	/**
	 * The optional push mirror of the vault's history (DESIGN §5.8, ROADMAP item 2). Off while {@code url} is empty.
	 * {@code tokenFile} holds the access token (a compose secret); the token itself is never configured directly.
	 */
	public record Mirror(
			@DefaultValue("") String url,
			@DefaultValue("") String tokenFile,
			@DefaultValue("x-access-token") String username,
			@DefaultValue("10m") Duration delay,
			@DefaultValue("1h") Duration maxDelay,
			@DefaultValue("60s") Duration timeout) {
	}

	/**
	 * App-error alerts (DESIGN §5.18, ROADMAP item 38): the stable log markers pushed to ntfy when
	 * {@code <secrets-dir>/ntfy.json} configures it. A marker is sent at most once per {@code repeatAfter} (repeats are
	 * summed up in one follow-up), and at most {@code maxPerHour} alerts are sent in any hour.
	 */
	public record Alerts(
			@DefaultValue("1h") Duration repeatAfter,
			@DefaultValue("10") int maxPerHour) {
	}

	/**
	 * The nightly backups as the status page shows them (ROADMAP items 1 and 38): {@code statusFile} is the backup
	 * run's {@code status.json}, mounted read-only from the {@code backup-state} volume; a last success older than
	 * {@code staleAfter} is shown as stale.
	 */
	public record Backup(
			@DefaultValue("/backup-state/status.json") Path statusFile,
			@DefaultValue("36h") Duration staleAfter) {
	}

	/**
	 * Transcription of voice notes (DESIGN §5.24, ROADMAP item 33) by an optional speech-to-text service, off while
	 * {@code url} is empty. {@code api} is the service's protocol: {@code whisper-asr} (the whisper-asr-webservice
	 * sidecar of DEPLOY.md, {@code POST <url>/asr}) or {@code openai} ({@code POST <url>/v1/audio/transcriptions}:
	 * whisper.cpp's server, speaches, LocalAI or OpenAI itself), which sends {@code model} and, when
	 * {@code apiKeyFile} names one, the key in that file (a compose secret, never configured directly). An empty
	 * {@code language} lets the service detect it. Recordings larger than {@code maxSize} are not sent.
	 */
	public record Transcription(
			@DefaultValue("") String url,
			@DefaultValue("whisper-asr") TranscriptionApi api,
			@DefaultValue("whisper-1") String model,
			@DefaultValue("") String language,
			@DefaultValue("") String apiKeyFile,
			@DefaultValue("10m") Duration timeout,
			@DefaultValue("25MB") DataSize maxSize) {

		public boolean enabled() {
			return !this.url.isBlank();
		}

	}

	/** The protocol of the transcription service. */
	public enum TranscriptionApi {

		/** whisper-asr-webservice: {@code POST /asr?output=json}, the file in {@code audio_file}. */
		WHISPER_ASR,

		/** OpenAI's {@code POST /v1/audio/transcriptions}, the file in {@code file}. */
		OPENAI

	}

	public record Watcher(
			@DefaultValue("true") boolean enabled,
			@DefaultValue("400ms") Duration debounce,
			@DefaultValue("5m") Duration rescanInterval) {
	}

	public record Sse(
			@DefaultValue("30m") Duration timeout,
			@DefaultValue("20s") Duration heartbeat,
			@DefaultValue("1024") int replayBuffer) {
	}

	public record Limits(
			@DefaultValue("5MB") DataSize maxTextSize,
			@DefaultValue Map<String, DataSize> textSizeOverrides,
			@DefaultValue("100MB") DataSize maxUploadSize,
			@DefaultValue("16MB") DataSize maxJsonBody,
			@DefaultValue("1GB") DataSize minFreeSpace) {
	}

	public record Identity(
			@DefaultValue("Owner") String defaultName,
			@DefaultValue("owner@notes") String defaultLogin,
			@DefaultValue("false") boolean allowDefault,
			@DefaultValue List<String> allowedLogins) {
	}

	public record Security(
			@DefaultValue("true") boolean requireTailscaleInterface,
			@DefaultValue("false") boolean allowUserspaceTailscale) {
	}

	/** Structured tasks (ROADMAP item 4): when completed tasks roll into the archive files. */
	public record Tasks(
			@DefaultValue("90d") Duration archiveAfter,
			@DefaultValue("0 20 3 * * *") String archiveCron) {
	}

	/**
	 * Full-text search (DESIGN §5.5.10). {@code timeout} bounds one query's regular expressions and
	 * {@code line:}/{@code section:} clauses; at most {@code maxConcurrentExpensive} such queries run at once.
	 */
	public record Search(
			@DefaultValue("2s") Duration timeout,
			@DefaultValue("2") int maxConcurrentExpensive,
			@DefaultValue Pdf pdf) {
	}

	/**
	 * Text extraction from PDF attachments for search, in the background: files over {@code maxSize}, pages after
	 * {@code maxPages}, text after {@code maxChars} characters and work after {@code timeout} per file are skipped.
	 */
	public record Pdf(
			@DefaultValue("true") boolean enabled,
			@DefaultValue("64MB") DataSize maxSize,
			@DefaultValue("2000") int maxPages,
			@DefaultValue("1000000") int maxChars,
			@DefaultValue("60s") Duration timeout) {
	}

	/**
	 * Public publishing (DESIGN §5.28, ROADMAP item 26), off unless {@code enabled}. The separate publish server binds
	 * {@code address:port} and serves only the snapshots under {@code dir} (outside the vault); {@code baseUrl} is the
	 * public origin shown for copying links (the Funnel address, e.g. {@code https://notes.<tailnet>.ts.net:8443}).
	 * Attachments larger than {@code maxAssetSize} are left out of a snapshot.
	 */
	public record Publish(
			@DefaultValue("false") boolean enabled,
			@DefaultValue("127.0.0.1") String address,
			@DefaultValue("8081") int port,
			@DefaultValue("/data/publish") Path dir,
			@DefaultValue("") String baseUrl,
			@DefaultValue("25MB") DataSize maxAssetSize) {
	}

	/**
	 * Multiple vaults (DESIGN §5.38, ROADMAP item 37). The vault at {@code notes.vault-dir} is the default vault, named
	 * {@code defaultName}, and keeps its unprefixed URLs. Every folder directly under {@code dir} whose name is a valid
	 * vault name is one more vault, served under {@code /v/<name>/} and {@code /api/v/<name>/} by an application
	 * context of its own. An empty {@code dir} turns extra vaults off; {@code allowCreate} lets the app create new vault
	 * folders there, at most {@code max} vaults in all. {@code current} is set by the server for each extra vault's own
	 * context and is never configured.
	 */
	public record Vaults(
			@DefaultValue("/data/vaults") String dir,
			@DefaultValue("main") String defaultName,
			@DefaultValue("true") boolean allowCreate,
			@DefaultValue("20") int max,
			@DefaultValue("") String current) {

		/** The folder of the extra vaults, or null when they are off. */
		public @Nullable Path dirPath() {
			return this.dir.isBlank() ? null : Path.of(this.dir);
		}

		/** The name of the vault this context serves. */
		public String currentName() {
			return this.current.isBlank() ? this.defaultName : this.current;
		}

		/** True in the default vault's context (the main application). */
		public boolean isDefault() {
			return this.current.isBlank() || this.current.equals(this.defaultName);
		}

	}

	public record TailscaleWatchdog(
			@DefaultValue("false") boolean enabled,
			@DefaultValue("http://127.0.0.1:9002/healthz") URI url,
			@DefaultValue("10s") Duration interval,
			@DefaultValue("6") int failures,
			@DefaultValue("3") int maxExits,
			@DefaultValue("10m") Duration exitWindow) {
	}

}
