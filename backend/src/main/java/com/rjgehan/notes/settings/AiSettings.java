package com.rjgehan.notes.settings;

import java.util.List;

import com.rjgehan.notes.vault.PathNames;

/**
 * {@code settings.ai}: Ask your vault and summaries, powered by Claude (ROADMAP item 18, API.md §5, DESIGN §5.20).
 * Off by default; note text leaves the tailnet only when it is on and you ask.
 *
 * @param enabled whether the feature may be used at all (the server also needs the provider's credential file)
 * @param provider one of {@link #PROVIDERS}: {@code claude-code} (the default) or {@code api}
 * @param model one of {@link #MODELS}
 * @param excludedPaths folders or files whose text is never sent (case-insensitive prefixes, as
 * {@code files.excludedPaths}, which are never sent either)
 * @param maxContextChars the most characters of note text one request may carry, history included
 * @param monthlyBudgetUsd requests are refused once this month's estimated spend reaches this amount
 */
public record AiSettings(boolean enabled, String provider, String model, List<String> excludedPaths, int maxContextChars,
		double monthlyBudgetUsd) {

	/** The models Settings offers, the default first: Sonnet for everyday use, Opus for harder questions. */
	public static final List<String> MODELS = List.of("claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5");

	/** Claude Code with the user's Claude subscription (the default), or the Anthropic API billed per token. */
	public static final String PROVIDER_CLAUDE_CODE = "claude-code";

	public static final String PROVIDER_API = "api";

	public static final List<String> PROVIDERS = List.of(PROVIDER_CLAUDE_CODE, PROVIDER_API);

	public static final int MIN_CONTEXT_CHARS = 4_000;

	public static final int MAX_CONTEXT_CHARS = 400_000;

	public static final double MAX_BUDGET_USD = 10_000;

	public AiSettings {
		excludedPaths = List.copyOf(excludedPaths);
	}

	public static AiSettings defaults() {
		return new AiSettings(false, PROVIDER_CLAUDE_CODE, MODELS.get(0), List.of("Private"), 60_000, 5.0);
	}

	/**
	 * True when {@code path} is under one of {@code excludedPaths}: an entry is a file, or a folder that excludes
	 * everything under it, compared case-insensitively at segment boundaries.
	 */
	public boolean isExcluded(String path) {
		String lower = PathNames.lower(path);
		for (String excluded : this.excludedPaths) {
			String prefix = PathNames.lower(excluded);
			while (prefix.endsWith("/")) {
				prefix = prefix.substring(0, prefix.length() - 1);
			}
			if (!prefix.isEmpty() && (lower.equals(prefix) || lower.startsWith(prefix + "/"))) {
				return true;
			}
		}
		return false;
	}

}
