package com.rjgehan.notes.ai;

import java.nio.file.Path;
import java.util.function.BooleanSupplier;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.settings.AiSettings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The two ways to reach Claude (DESIGN §5.20), chosen in Settings ({@code settings.ai.provider}): <b>Claude Code</b>
 * (the default), the CLI run headless with the user's Claude subscription and its OAuth token from
 * {@code /data/secrets/claude-token}; and the <b>Anthropic API</b>, through the official SDK with an API key from
 * {@code /data/secrets/anthropic-key}, billed per token. With {@code notes.ai.fake} both answer with canned text.
 */
@Component
public class AiProviders implements DisposableBean {

	private static final Logger logger = LoggerFactory.getLogger(AiProviders.class);

	/** One provider: how to call it, and where its credential is. */
	public record Provider(String id, ClaudeGateway gateway, ApiKeyFile credential) {
	}

	private final boolean fake;

	private final Provider claudeCode;

	private final Provider api;

	private final BooleanSupplier cliInstalled;

	private final String cliCommand;

	@Autowired
	public AiProviders(AiProperties properties, NotesProperties notes) {
		this(properties.fake(), claudeCode(properties, notes), api(properties, notes),
				cli(properties)::installed, properties.claudeCommand());
		if (properties.fake()) {
			logger.warn("notes.ai.fake is set: Ask and summaries answer with canned text and never call Claude");
		}
	}

	AiProviders(boolean fake, Provider claudeCode, Provider api, BooleanSupplier cliInstalled, String cliCommand) {
		this.fake = fake;
		this.claudeCode = claudeCode;
		this.api = api;
		this.cliInstalled = cliInstalled;
		this.cliCommand = cliCommand;
	}

	private static ClaudeCodeGateway cli(AiProperties properties) {
		Path work = properties.claudeWorkDir().isBlank()
				? Path.of(System.getProperty("java.io.tmpdir"), "notesapp-claude") : Path.of(properties.claudeWorkDir());
		return new ClaudeCodeGateway(properties.claudeCommand(), work, properties.timeout(),
				ClaudeCodeGateway.Launcher.DEFAULT);
	}

	private static Provider claudeCode(AiProperties properties, NotesProperties notes) {
		Path token = properties.claudeTokenFile().isBlank() ? notes.secretsDir().resolve(ApiKeyFile.CLAUDE_TOKEN_NAME)
				: Path.of(properties.claudeTokenFile().strip());
		ClaudeGateway gateway = properties.fake() ? new FakeGateway(25) : cli(properties);
		return new Provider(AiSettings.PROVIDER_CLAUDE_CODE, gateway, new ApiKeyFile(token, "Claude Code token"));
	}

	private static Provider api(AiProperties properties, NotesProperties notes) {
		Path key = properties.apiKeyFile().isBlank() ? notes.secretsDir().resolve(ApiKeyFile.API_KEY_NAME)
				: Path.of(properties.apiKeyFile().strip());
		ClaudeGateway gateway = properties.fake() ? new FakeGateway(25) : new AnthropicGateway(properties.timeout());
		return new Provider(AiSettings.PROVIDER_API, gateway, new ApiKeyFile(key, "API key"));
	}

	public Provider get(String id) {
		return AiSettings.PROVIDER_API.equals(id) ? this.api : this.claudeCode;
	}

	public boolean fake() {
		return this.fake;
	}

	/** True when the Claude Code CLI is on this server (always for the fake). */
	public boolean cliInstalled() {
		return this.fake || this.cliInstalled.getAsBoolean();
	}

	public String cliCommand() {
		return this.cliCommand;
	}

	@Override
	public void destroy() {
		if (this.api.gateway() instanceof AnthropicGateway gateway) {
			gateway.close();
		}
	}

}
