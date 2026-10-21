package com.rjgehan.notes.ai;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.JsonValue;
import com.anthropic.core.http.StreamResponse;
import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.models.beta.AnthropicBeta;
import com.anthropic.models.beta.messages.BetaCacheControlEphemeral;
import com.anthropic.models.beta.messages.BetaContentBlockParam;
import com.anthropic.models.beta.messages.BetaMessage;
import com.anthropic.models.beta.messages.BetaMessageDeltaUsage;
import com.anthropic.models.beta.messages.BetaOutputConfig;
import com.anthropic.models.beta.messages.BetaRawContentBlockStartEvent;
import com.anthropic.models.beta.messages.BetaRawMessageDeltaEvent;
import com.anthropic.models.beta.messages.BetaRawMessageStreamEvent;
import com.anthropic.models.beta.messages.BetaTextBlockParam;
import com.anthropic.models.beta.messages.BetaUsage;
import com.anthropic.models.beta.messages.MessageCreateParams;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@link ClaudeGateway} over the official Anthropic Java SDK ({@code com.anthropic:anthropic-java}): a streamed
 * {@code POST /v1/messages} on the beta endpoint, which carries the server-side refusal fallback
 * ({@code fallbacks: "default"}, beta {@code server-side-fallback-2026-07-01}). Adaptive thinking is the models'
 * default and is left on; {@code output_config.effort} sets its depth. One client is kept per API key and rebuilt when
 * the key file changes. The client is built with the key alone (no {@code fromEnv()}), so no environment variable can
 * redirect requests or substitute credentials.
 */
public class AnthropicGateway implements ClaudeGateway, AutoCloseable {

	private static final Logger logger = LoggerFactory.getLogger(AnthropicGateway.class);

	static final String BASE_URL = "https://api.anthropic.com";

	private static final Pattern SECRET = Pattern.compile("sk-ant-[A-Za-z0-9_-]+");

	private static final int MAX_MESSAGE = 200;

	private record Holder(String key, AnthropicClient client) {
	}

	private final Duration timeout;

	private final String baseUrl;

	private @Nullable Holder holder;

	public AnthropicGateway(Duration timeout) {
		this(timeout, BASE_URL);
	}

	/** {@code baseUrl}: the tests point it at a local server that replays recorded streams. */
	AnthropicGateway(Duration timeout, String baseUrl) {
		this.baseUrl = baseUrl;
		this.timeout = timeout;
	}

	@Override
	public Result stream(Request request, Listener listener) throws ClaudeException {
		AnthropicClient client = client(request.apiKey());
		MessageCreateParams params = params(request);
		State state = new State(request.model());
		try (StreamResponse<BetaRawMessageStreamEvent> response = client.beta().messages().createStreaming(params)) {
			Iterator<BetaRawMessageStreamEvent> events = response.stream().iterator();
			while (events.hasNext()) {
				state.apply(events.next(), listener);
			}
		}
		catch (AnthropicServiceException ex) {
			throw translate(ex);
		}
		catch (AnthropicIoException ex) {
			throw new ClaudeException(ClaudeException.Kind.UNAVAILABLE,
					"Could not reach the Claude API (" + ex.getClass().getSimpleName() + ")");
		}
		return state.result();
	}

	/** The request as the SDK sends it. Visible for tests, which check the wire shape without a network. */
	static MessageCreateParams params(Request request) {
		MessageCreateParams.Builder builder = MessageCreateParams.builder()
			.model(request.model())
			.maxTokens(request.maxTokens())
			.systemOfBetaTextBlockParams(List.of(BetaTextBlockParam.builder().text(request.system()).build()))
			.outputConfig(BetaOutputConfig.builder().effort(BetaOutputConfig.Effort.of(request.effort())).build());
		for (Message message : request.messages()) {
			if (message.role() == Role.ASSISTANT) {
				builder.addAssistantMessage(message.blocks().stream().map(Block::text).reduce("", String::concat));
				continue;
			}
			List<BetaContentBlockParam> blocks = new ArrayList<>();
			for (Block block : message.blocks()) {
				BetaTextBlockParam.Builder text = BetaTextBlockParam.builder().text(block.text());
				if (block.cacheBreakpoint()) {
					text.cacheControl(BetaCacheControlEphemeral.builder().build());
				}
				blocks.add(BetaContentBlockParam.ofText(text.build()));
			}
			builder.addUserMessageOfContentBlockParams(blocks);
		}
		if (request.fallbacks()) {
			builder.fallbacksDefault().addBeta(AnthropicBeta.SERVER_SIDE_FALLBACK_2026_07_01);
		}
		return builder.build();
	}

	private synchronized AnthropicClient client(String key) {
		Holder current = this.holder;
		if (current != null && current.key().equals(key)) {
			return current.client();
		}
		AnthropicClient client = AnthropicOkHttpClient.builder()
			.apiKey(key)
			.baseUrl(this.baseUrl)
			.timeout(this.timeout)
			.maxRetries(2)
			.build();
		this.holder = new Holder(key, client);
		if (current != null) {
			logger.info("The Anthropic API key file changed; using the new key");
			current.client().close();
		}
		return client;
	}

	@Override
	public synchronized void close() {
		if (this.holder != null) {
			this.holder.client().close();
			this.holder = null;
		}
	}

	/** Collects the model, the stop reason and the token counts while the events stream by. */
	private static final class State {

		private String model;

		private @Nullable String stopReason;

		private @Nullable String refusalCategory;

		private boolean fellBack;

		private long inputTokens;

		private long outputTokens;

		private long cacheRead;

		private long cacheWrite;

		private final List<Hop> iterations = new ArrayList<>();

		State(String model) {
			this.model = model;
		}

		void apply(BetaRawMessageStreamEvent event, Listener listener) {
			event.messageStart().ifPresent((start) -> start(start.message()));
			event.contentBlockStart().ifPresent((start) -> blockStart(start, listener));
			event.contentBlockDelta()
				.flatMap((delta) -> delta.delta().text())
				.ifPresent((text) -> listener.onText(text.text()));
			event.messageDelta().ifPresent(this::delta);
		}

		private void start(BetaMessage message) {
			this.model = message.model().asString();
			BetaUsage usage = message.usage();
			this.inputTokens = usage.inputTokens();
			this.outputTokens = usage.outputTokens();
			this.cacheRead = usage.cacheReadInputTokens().orElse(0L);
			this.cacheWrite = usage.cacheCreationInputTokens().orElse(0L);
		}

		private void blockStart(BetaRawContentBlockStartEvent start, Listener listener) {
			if (start.contentBlock().isFallback()) {
				this.fellBack = true;
				this.model = start.contentBlock().asFallback().to().model().asString();
				listener.onRestart(this.model);
			}
		}

		private void delta(BetaRawMessageDeltaEvent delta) {
			BetaRawMessageDeltaEvent.Delta d = delta.delta();
			d.stopReason().ifPresent((reason) -> this.stopReason = reason.asString());
			d.stopDetails().flatMap((details) -> details.category())
				.ifPresent((category) -> this.refusalCategory = category.asString());
			BetaMessageDeltaUsage usage = delta.usage();
			// The delta's counts are cumulative.
			this.outputTokens = usage.outputTokens();
			usage.inputTokens().ifPresent((n) -> this.inputTokens = n);
			usage.cacheReadInputTokens().ifPresent((n) -> this.cacheRead = n);
			usage.cacheCreationInputTokens().ifPresent((n) -> this.cacheWrite = n);
			usage.iterations().ifPresent((iterations) -> {
				this.iterations.clear();
				for (BetaMessageDeltaUsage.Iteration iteration : iterations) {
					String hopModel = iteration.model().map((m) -> m.asString()).orElse(this.model);
					this.iterations.add(new Hop(hopModel, new AiModels.Usage(iteration.inputTokens(),
							iteration.outputTokens(), iteration.cacheReadInputTokens(),
							iteration.cacheCreationInputTokens())));
				}
			});
		}

		Result result() {
			List<Hop> hops = this.iterations.isEmpty() ? List.of(new Hop(this.model,
					new AiModels.Usage(this.inputTokens, this.outputTokens, this.cacheRead, this.cacheWrite)))
					: this.iterations;
			return new Result(this.model, (this.stopReason != null) ? this.stopReason : "end_turn",
					this.refusalCategory, hops, this.fellBack);
		}

	}

	/** Maps an API error to a kind and a short text without secrets. */
	static ClaudeException translate(AnthropicServiceException ex) {
		int status = ex.statusCode();
		String type = ex.errorType().map((t) -> t.toString().toLowerCase(Locale.ROOT)).orElse("");
		ClaudeException.Kind kind;
		String text;
		if (status == 401 || status == 403 || type.contains("authentication") || type.contains("permission")) {
			kind = ClaudeException.Kind.AUTH;
			text = "The Claude API refused the API key (HTTP " + status + ")";
		}
		else if (status == 429 || type.contains("rate_limit")) {
			kind = ClaudeException.Kind.RATE_LIMITED;
			text = "The Claude API is rate-limiting this key, or its spend limit is reached";
		}
		else if (status == 529 || status == 503 || type.contains("overloaded")) {
			kind = ClaudeException.Kind.OVERLOADED;
			text = "The Claude API is overloaded; try again in a minute";
		}
		else if (status == 400 || status == 404 || status == 413 || status == 422) {
			kind = ClaudeException.Kind.BAD_REQUEST;
			text = "The Claude API refused the request (HTTP " + status + ")";
		}
		else {
			kind = ClaudeException.Kind.UNAVAILABLE;
			text = "The Claude API answered HTTP " + status;
		}
		String detail = apiMessage(ex.body());
		return new ClaudeException(kind, (detail != null) ? text + ": " + detail : text);
	}

	/** The {@code error.message} of an API error body, scrubbed and capped, or null. */
	static @Nullable String apiMessage(JsonValue body) {
		Object error = member(body, "error");
		Object message = (error instanceof JsonValue value) ? member(value, "message") : null;
		Optional<?> text = (message instanceof JsonValue value) ? value.asString() : Optional.empty();
		if (text.isEmpty() || !(text.get() instanceof String string) || string.isBlank()) {
			return null;
		}
		String scrubbed = SECRET.matcher(string.strip()).replaceAll("***");
		return (scrubbed.length() > MAX_MESSAGE) ? scrubbed.substring(0, MAX_MESSAGE) + "…" : scrubbed;
	}

	private static @Nullable Object member(JsonValue value, String name) {
		Optional<?> object = value.asObject();
		return (object.isPresent() && object.get() instanceof Map<?, ?> map) ? map.get(name) : null;
	}

}
