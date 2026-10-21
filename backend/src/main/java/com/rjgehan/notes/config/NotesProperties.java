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
		@DefaultValue Search search,
		@DefaultValue({ "md", "markdown", "txt", "json", "canvas", "excalidraw", "sheet", "tasks", "csv", "tsv", "yaml",
				"yml" }) List<String> textExtensions,
		@DefaultValue("true") boolean welcomeNote,
		@DefaultValue("dev") String buildSha) {

	public record Git(
			@DefaultValue("true") boolean enabled,
			@DefaultValue("30s") Duration commitQuietPeriod,
			@DefaultValue("5m") Duration commitMaxDelay,
			@DefaultValue("NotesApp") String committerName,
			@DefaultValue("notesapp@notes") String committerEmail,
			@DefaultValue("0 30 3 * * *") String gcCron) {
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
