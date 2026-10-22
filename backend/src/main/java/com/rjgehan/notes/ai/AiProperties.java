package com.rjgehan.notes.ai;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * {@code notes.ai.*}: the server side of Ask your vault and summaries (ROADMAP item 18, DESIGN §5.25). What the user
 * chooses (on or off, the provider, the model, excluded folders, the context cap, the monthly budget) is in the vault
 * settings ({@code settings.ai}); these are the operator's.
 *
 * @param claudeTokenFile the file holding the Claude Code OAuth token made with {@code claude setup-token}
 * ({@code NOTES_AI_CLAUDE_TOKEN_FILE}); empty means {@code <notes.secrets-dir>/claude-token}. Used by the default
 * provider, Claude Code with the user's subscription
 * @param claudeCommand the Claude Code CLI ({@code NOTES_AI_CLAUDE_COMMAND}): a path, or a name looked up on the
 * {@code PATH}. The image has it at {@code /opt/claude/bin/claude}
 * @param claudeWorkDir where each run gets a fresh, empty home and working directory, deleted afterwards; empty means
 * {@code <java.io.tmpdir>/notesapp-claude}
 * @param apiKeyFile the file holding the Anthropic API key for the optional API provider
 * ({@code NOTES_AI_API_KEY_FILE}); empty means {@code <notes.secrets-dir>/anthropic-key}
 * @param fake answer every request with a canned reply built from the retrieved notes, without any process or network
 * call: for development and the browser smoke test, never in production
 * @param maxOutputTokens the {@code max_tokens} of every API request (thinking included)
 * @param effort the {@code output_config.effort} of every API request ({@code low}, {@code medium}, {@code high})
 * @param timeout how long one answer may take, streaming included
 * @param maxConcurrent answers written at once; more are refused as busy
 */
@ConfigurationProperties("notes.ai")
public record AiProperties(
		@DefaultValue("") String claudeTokenFile,
		@DefaultValue("claude") String claudeCommand,
		@DefaultValue("") String claudeWorkDir,
		@DefaultValue("") String apiKeyFile,
		@DefaultValue("false") boolean fake,
		@DefaultValue("16000") int maxOutputTokens,
		@DefaultValue("medium") String effort,
		@DefaultValue("5m") Duration timeout,
		@DefaultValue("2") int maxConcurrent) {
}
