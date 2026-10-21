package com.rjgehan.notes.ai;

import java.util.List;

import org.jspecify.annotations.Nullable;

/**
 * One streamed call of the Claude Messages API. {@link AnthropicGateway} makes it through the official SDK,
 * {@link FakeGateway} answers without the network (development, {@code notes.ai.fake}), and tests mock it.
 */
public interface ClaudeGateway {

	/**
	 * Streams one answer: every piece of text goes to {@code listener} as it arrives. Blocks until the answer is
	 * complete. When the listener throws (the browser went away), the call stops and the exception propagates, so the
	 * upstream request is closed and no more output is generated or paid for.
	 *
	 * @throws ClaudeException when the API refuses the request or cannot be reached
	 */
	Result stream(Request request, Listener listener) throws ClaudeException;

	/**
	 * A request: the system prompt, then alternating user and assistant messages, the last one from the user.
	 *
	 * @param model a model id such as {@code claude-sonnet-5-5}
	 * @param fallbacks ask for the server-side fallback ({@code fallbacks: "default"}) when the model declines
	 */
	record Request(String credential, String model, String system, List<Message> messages, int maxTokens, String effort,
			boolean fallbacks) {

		public Request {
			messages = List.copyOf(messages);
		}

		@Override
		public String toString() {
			return "Request[model=" + this.model + ", messages=" + this.messages.size() + "]";
		}

	}

	/** One message: its role and its text blocks. */
	record Message(Role role, List<Block> blocks) {

		public Message {
			blocks = List.copyOf(blocks);
		}

		public static Message user(Block... blocks) {
			return new Message(Role.USER, List.of(blocks));
		}

		public static Message assistant(String text) {
			return new Message(Role.ASSISTANT, List.of(new Block(text, false)));
		}

		public int chars() {
			return this.blocks.stream().mapToInt((block) -> block.text().length()).sum();
		}

	}

	enum Role {

		USER, ASSISTANT

	}

	/**
	 * A text block. {@code cacheBreakpoint} puts a prompt-caching breakpoint after it: the prefix up to here is cached
	 * for five minutes, so a follow-up question reads its notes from the cache.
	 */
	record Block(String text, boolean cacheBreakpoint) {
	}

	/** Receives the answer as it is generated. */
	interface Listener {

		/** A piece of the answer's text. */
		void onText(String text);

		/**
		 * A fallback model takes over after the first model declined part way through: the text so far is void and the
		 * answer starts again.
		 */
		default void onRestart(String model) {
		}

	}

	/**
	 * How the answer ended.
	 *
	 * @param model the model that produced the answer (a fallback model when one took over)
	 * @param stopReason {@code end_turn}, {@code max_tokens}, {@code refusal}, …
	 * @param refusalCategory the category of a refusal, when the API says
	 * @param hops the tokens each model used: one entry, or one per model when a fallback took over
	 */
	record Result(String model, String stopReason, @Nullable String refusalCategory, List<Hop> hops,
			boolean fellBack, @Nullable Double reportedCostUsd) {

		public Result {
			hops = List.copyOf(hops);
		}

		public Result(String model, String stopReason, @Nullable String refusalCategory, List<Hop> hops,
				boolean fellBack) {
			this(model, stopReason, refusalCategory, hops, fellBack, null);
		}

		public AiModels.Usage usage() {
			return this.hops.stream().map(Hop::usage).reduce(AiModels.Usage.ZERO, AiModels.Usage::plus);
		}

		/**
		 * The estimated cost in USD: what the provider reported (Claude Code's {@code total_cost_usd}, the API value of
		 * a subscription run), or each hop at its own model's list prices.
		 */
		public double cost() {
			if (this.reportedCostUsd != null && this.reportedCostUsd >= 0) {
				return this.reportedCostUsd;
			}
			return this.hops.stream().mapToDouble((hop) -> AiModels.of(hop.model()).cost(hop.usage())).sum();
		}

	}

	/** The tokens one model used for a request. */
	record Hop(String model, AiModels.Usage usage) {
	}

	/** Why a call failed, in a form the browser can show; never contains the key or note text. */
	final class ClaudeException extends Exception {

		public enum Kind {

			/** The key was refused (401, 403). */
			AUTH,
			/** Too many requests, or the organization's spend limit (429). */
			RATE_LIMITED,
			/** The API is overloaded (529, 503). */
			OVERLOADED,
			/** The request was refused as invalid (400), for example when it is too long. */
			BAD_REQUEST,
			/** The network, a timeout, or another HTTP status. */
			UNAVAILABLE

		}

		private final Kind kind;

		public ClaudeException(Kind kind, String message) {
			super(message);
			this.kind = kind;
		}

		public Kind kind() {
			return this.kind;
		}

	}

}
