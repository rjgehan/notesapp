package com.rjgehan.notes.ai;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * {@code notes.ai.*}: the server side of Ask your vault and summaries (ROADMAP item 18, DESIGN §5.20). What the user
 * chooses (on or off, the model, excluded folders, the context cap, the monthly budget) is in the vault settings
 * ({@code settings.ai}); these are the operator's.
 *
 * @param apiKeyFile the file holding the Anthropic API key ({@code NOTES_AI_API_KEY_FILE}); empty means
 * {@code <notes.secrets-dir>/anthropic-key}. The key is never configured directly, never in the vault, settings or logs
 * @param fake answer every request with a canned reply built from the retrieved notes, without any network call: for
 * development and the browser smoke test, never in production
 * @param maxOutputTokens the {@code max_tokens} of every request (thinking included)
 * @param effort the {@code output_config.effort} of every request ({@code low}, {@code medium}, {@code high})
 * @param timeout how long one request may take, streaming included
 * @param maxConcurrent requests running at once; more are refused as busy
 */
@ConfigurationProperties("notes.ai")
public record AiProperties(
		@DefaultValue("") String apiKeyFile,
		@DefaultValue("false") boolean fake,
		@DefaultValue("16000") int maxOutputTokens,
		@DefaultValue("medium") String effort,
		@DefaultValue("5m") Duration timeout,
		@DefaultValue("2") int maxConcurrent) {
}
