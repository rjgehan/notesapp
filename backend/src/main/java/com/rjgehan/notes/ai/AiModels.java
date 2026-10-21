package com.rjgehan.notes.ai;

import java.util.List;
import java.util.Map;

import com.rjgehan.notes.settings.AiSettings;

/**
 * The Claude models Settings offers and the prices the spend guard estimates with (USD per million tokens, first-party
 * API list prices of 2026-10). A server-side fallback can answer with another model; those are priced too, and an
 * unknown model is priced like the most expensive one, so the estimate errs high.
 */
public final class AiModels {

	/** One model: its label and prices in USD per million input, output, cache-read and cache-write tokens. */
	public record Model(String id, String label, double input, double output, double cacheRead, double cacheWrite,
			boolean serverFallback) {

		/** The estimated cost of one request in USD. */
		public double cost(Usage usage) {
			return (usage.inputTokens() * this.input + usage.outputTokens() * this.output
					+ usage.cacheReadInputTokens() * this.cacheRead
					+ usage.cacheCreationInputTokens() * this.cacheWrite) / 1_000_000.0;
		}

	}

	/** Token counts of one request, as the API reports them. */
	public record Usage(long inputTokens, long outputTokens, long cacheReadInputTokens, long cacheCreationInputTokens) {

		public static final Usage ZERO = new Usage(0, 0, 0, 0);

		public Usage plus(Usage other) {
			return new Usage(this.inputTokens + other.inputTokens, this.outputTokens + other.outputTokens,
					this.cacheReadInputTokens + other.cacheReadInputTokens,
					this.cacheCreationInputTokens + other.cacheCreationInputTokens);
		}

	}

	// Cache writes cost 1.25 times the input price (5-minute cache).
	private static final Map<String, Model> MODELS = Map.of(
			"claude-sonnet-5-5", new Model("claude-sonnet-5-5", "Claude Sonnet 5.5", 2.00, 10.00, 0.20, 2.50, true),
			"claude-opus-5-5", new Model("claude-opus-5-5", "Claude Opus 5.5", 4.00, 20.00, 0.20, 5.00, true),
			// No server-side fallback exists for Haiku 5.5: the request must not ask for one.
			"claude-haiku-5-5", new Model("claude-haiku-5-5", "Claude Haiku 5.5", 0.10, 0.50, 0.01, 0.125, false),
			// Fallback targets.
			"claude-sonnet-5", new Model("claude-sonnet-5", "Claude Sonnet 5", 2.00, 10.00, 0.20, 2.50, false),
			"claude-opus-5", new Model("claude-opus-5", "Claude Opus 5", 5.00, 25.00, 0.50, 6.25, false),
			"claude-opus-4-8", new Model("claude-opus-4-8", "Claude Opus 4.8", 5.00, 25.00, 0.50, 6.25, false));

	private static final Model MOST_EXPENSIVE = MODELS.get("claude-opus-4-8");

	private AiModels() {
	}

	/** The models Settings offers, the default first. */
	public static List<Model> selectable() {
		return AiSettings.MODELS.stream().map(MODELS::get).toList();
	}

	/** The model with this id; an unknown id (a new fallback target) gets the highest prices. */
	public static Model of(String id) {
		Model model = MODELS.get(id);
		return (model != null) ? model : new Model(id, id, MOST_EXPENSIVE.input(), MOST_EXPENSIVE.output(),
				MOST_EXPENSIVE.cacheRead(), MOST_EXPENSIVE.cacheWrite(), false);
	}

}
