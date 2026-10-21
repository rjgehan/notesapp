package com.rjgehan.notes.config;

import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import jakarta.validation.constraints.NotNull;

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
		@DefaultValue("/data/secrets") Path secretsDir,
		@DefaultValue Tasks tasks,
		@DefaultValue Search search,
		@DefaultValue({ "md", "markdown", "txt", "json", "canvas", "excalidraw", "sheet", "tasks", "csv", "tsv", "yaml",
				"yml" }) List<String> textExtensions,
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

	public record TailscaleWatchdog(
			@DefaultValue("false") boolean enabled,
			@DefaultValue("http://127.0.0.1:9002/healthz") URI url,
			@DefaultValue("10s") Duration interval,
			@DefaultValue("6") int failures,
			@DefaultValue("3") int maxExits,
			@DefaultValue("10m") Duration exitWindow) {
	}

}
