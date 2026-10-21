package com.rjgehan.notes.ai;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.function.Predicate;

import com.rjgehan.notes.ai.ClaudeGateway.ClaudeException;
import com.rjgehan.notes.api.dto.AiAskRequest;
import com.rjgehan.notes.api.dto.AiDeltaEvent;
import com.rjgehan.notes.api.dto.AiDoneEvent;
import com.rjgehan.notes.api.dto.AiErrorEvent;
import com.rjgehan.notes.api.dto.AiModelInfo;
import com.rjgehan.notes.api.dto.AiPrompt;
import com.rjgehan.notes.api.dto.AiRestartEvent;
import com.rjgehan.notes.api.dto.AiSource;
import com.rjgehan.notes.api.dto.AiStartEvent;
import com.rjgehan.notes.api.dto.AiState;
import com.rjgehan.notes.api.dto.AiStatus;
import com.rjgehan.notes.api.dto.AiSummarizeRequest;
import com.rjgehan.notes.api.dto.AiTurn;
import com.rjgehan.notes.api.dto.AiUsage;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.AiSettings;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * Ask your vault and summaries (ROADMAP item 18, DESIGN §5.20, API.md §20). A request is checked and its prompt built
 * before the response starts ({@link #prepareAsk}, {@link #prepareSummarize}), so refusals are ordinary problem
 * responses; {@link #run} then streams the answer as server-sent events and records the estimated cost.
 *
 * <p>Privacy: nothing is sent unless {@code settings.ai.enabled} is on, a key file exists, and a request asks. Excluded
 * notes are never read. Questions, answers and note text are never logged; the log line of a request has the model,
 * the counts and the cost.
 */
@Service
public class AiService {

	private static final Logger logger = LoggerFactory.getLogger(AiService.class);

	static final int MAX_QUESTION = 4_000;

	static final int MAX_LABEL = 200;

	static final int MAX_SELECTION = 200_000;

	static final int MAX_PATHS = 100;

	static final int MAX_HISTORY = 50;

	/** Earlier turns sent to the model; older ones are left out. */
	static final int HISTORY_TURNS = 12;

	static final int MAX_ANSWER = 100_000;

	/** Receives the events of one streamed answer (API.md §20.5). */
	public interface Sink {

		/** Sends one event; throws {@link ClientGoneException} when the browser is gone. */
		void send(String event, Object data);

	}

	/** The browser closed the stream: stop generating. */
	public static final class ClientGoneException extends RuntimeException {

		public ClientGoneException(Throwable cause) {
			super("the client went away", cause);
		}

	}

	/** A checked request with its prompt, ready to run. */
	public record Prepared(String kind, ClaudeGateway.Request request, AiStartEvent start, int historyTurns,
			ClaudeGateway gateway) {

		@Override
		public String toString() {
			return "Prepared[" + this.kind + ", " + this.request + "]";
		}

	}

	private final VaultIndex index;

	private final SettingsService settings;

	private final AiProviders providers;

	private final UsageLedger ledger;


	private final AiProperties properties;

	private final Clock clock;

	private final ZoneId zone;

	private final Semaphore running;

	public AiService(VaultIndex index, SettingsService settings, AiProviders providers, UsageLedger ledger,
			AiProperties properties, Clock clock) {
		this.index = index;
		this.settings = settings;
		this.providers = providers;
		this.ledger = ledger;
		this.properties = properties;
		this.clock = clock;
		this.zone = ZoneId.systemDefault();
		this.running = new Semaphore(Math.max(1, properties.maxConcurrent()));
	}

	// ---------------------------------------------------------------- status

	public AiStatus status() {
		AiSettings ai = this.settings.current().ai();
		AiProviders.Provider provider = this.providers.get(ai.provider());
		ApiKeyFile.Loaded key = provider.credential().load();
		boolean cli = this.providers.cliInstalled();
		UsageLedger.Month month = this.ledger.thisMonth();
		AiState state;
		String reason = null;
		String missing = missing(provider, key, cli);
		if (!ai.enabled()) {
			state = AiState.OFF;
			reason = "Ask and summaries are switched off in Settings";
		}
		else if (missing != null) {
			state = AiState.NOT_CONFIGURED;
			reason = missing;
		}
		else if (month.costUsd() >= ai.monthlyBudgetUsd()) {
			state = AiState.OVER_BUDGET;
			reason = "This month's estimated spend reached the budget of $" + money(ai.monthlyBudgetUsd());
		}
		else {
			state = AiState.READY;
		}
		List<AiModelInfo> models = AiModels.selectable().stream()
			.map((m) -> new AiModelInfo(m.id(), m.label(), m.input(), m.output()))
			.toList();
		return new AiStatus(state, reason, provider.id(), ai.model(), models, provider.credential().fileName(),
				key.present(), cli, this.ledger.currentMonth(), round(month.costUsd()), month.requests(),
				ai.monthlyBudgetUsd(), ai.maxContextChars(), this.providers.fake());
	}

	/** Why the provider cannot be used, or null; the fake needs nothing. */
	private @Nullable String missing(AiProviders.Provider provider, ApiKeyFile.Loaded key, boolean cli) {
		if (this.providers.fake()) {
			return null;
		}
		if (provider.id().equals(AiSettings.PROVIDER_CLAUDE_CODE) && !cli) {
			return "the Claude Code CLI (" + this.providers.cliCommand() + ") is not installed on the server";
		}
		return key.present() ? null : key.problem();
	}

	// ---------------------------------------------------------------- preparing

	public Prepared prepareAsk(AiAskRequest request) {
		Settings current = this.settings.current();
		Access access = checkAvailable(current.ai());
		String question = (request.question() != null) ? request.question().strip() : "";
		if (question.isEmpty() || question.length() > MAX_QUESTION) {
			throw NotesException.badRequest("question must be 1 to " + MAX_QUESTION + " characters");
		}
		String active = PromptBuilder.cleanPath(request.activePath());
		PromptBuilder builder = builder(current);
		History history = history(builder, request.history());
		int maxContext = current.ai().maxContextChars();
		int budget = Math.max(maxContext / 2, maxContext - history.chars());
		PromptBuilder.Turn turn = builder.ask(question, active, history.sentPaths(), budget);
		return prepared("ask", current, access, history, turn);
	}

	public Prepared prepareSummarize(AiSummarizeRequest request) {
		Settings current = this.settings.current();
		Access access = checkAvailable(current.ai());
		PromptBuilder.Prompt prompt = summaryPrompt(request.action(), request.scope(), request.path(), request.paths(),
				request.text(), request.label(), true);
		PromptBuilder builder = builder(current);
		checkTarget(prompt, excluded(current));
		History history = history(builder, request.history());
		PromptBuilder.Turn turn = builder.summarize(prompt);
		return prepared(prompt.action().name().toLowerCase(Locale.ROOT), current, access, history, turn);
	}

	private Prepared prepared(String kind, Settings current, Access access, History history,
			PromptBuilder.Turn turn) {
		AiSettings ai = current.ai();
		List<PromptBuilder.Turn> turns = new ArrayList<>(history.turns());
		// Old turns lose their notes first when the conversation outgrows the context limit; the new turn always keeps
		// its own.
		boolean[] withNotes = new boolean[turns.size()];
		int total = turn.chars();
		for (int i = turns.size() - 1; i >= 0; i--) {
			int chars = turns.get(i).chars();
			withNotes[i] = total + chars <= ai.maxContextChars() + ai.maxContextChars() / 10;
			if (withNotes[i]) {
				total += chars;
			}
			else {
				// Keep the prefix stable: once a turn is left out, so are all older ones.
				for (int j = i; j >= 0; j--) {
					withNotes[j] = false;
				}
				break;
			}
		}
		List<ClaudeGateway.Message> messages = new ArrayList<>();
		for (int i = 0; i < turns.size(); i++) {
			messages.add(ClaudeGateway.Message.user(new ClaudeGateway.Block(turns.get(i).render(withNotes[i]), false)));
			String answer = history.answers().get(i);
			messages.add(ClaudeGateway.Message.assistant(answer.isBlank() ? "(no answer)" : answer));
		}
		messages.add(ClaudeGateway.Message.user(new ClaudeGateway.Block(turn.render(true), true)));
		AiModels.Model model = AiModels.of(ai.model());
		boolean api = access.provider().id().equals(AiSettings.PROVIDER_API);
		ClaudeGateway.Request request = new ClaudeGateway.Request(access.credential(), model.id(),
				PromptBuilder.system(LocalDate.ofInstant(this.clock.instant(), this.zone)), messages,
				this.properties.maxOutputTokens(), this.properties.effort(), api && model.serverFallback());
		List<AiSource> sources = turn.sources().stream()
			.map((s) -> new AiSource(s.path(), s.chars(), s.truncated()))
			.toList();
		return new Prepared(kind, request, new AiStartEvent(model.id(), sources, turn.omitted(), turn.excluded()),
				turns.size(), access.provider().gateway());
	}

	/** The provider and its credential for a request. */
	private record Access(AiProviders.Provider provider, String credential) {

		@Override
		public String toString() {
			return "Access[" + this.provider.id() + "]";
		}

	}

	/** The provider and its credential, or a refusal when the feature is off, not set up, or over its budget. */
	private Access checkAvailable(AiSettings ai) {
		if (!ai.enabled()) {
			throw new NotesException(ErrorCode.AI_UNAVAILABLE, "Ask and summaries are switched off in Settings",
					Map.of("reason", "off"));
		}
		AiProviders.Provider provider = this.providers.get(ai.provider());
		ApiKeyFile.Loaded loaded = this.providers.fake() ? new ApiKeyFile.Loaded("fake", null)
				: provider.credential().load();
		String missing = missing(provider, loaded, this.providers.cliInstalled());
		if (missing != null || loaded.key() == null) {
			String what = provider.id().equals(AiSettings.PROVIDER_API) ? "The server cannot use the Anthropic API: "
					: "The server cannot use Claude Code: ";
			throw new NotesException(ErrorCode.AI_UNAVAILABLE, what + missing, Map.of("reason", "not-configured"));
		}
		UsageLedger.Month month = this.ledger.thisMonth();
		if (month.costUsd() >= ai.monthlyBudgetUsd()) {
			throw new NotesException(ErrorCode.AI_BUDGET_EXCEEDED, "This month's estimated spend ($"
					+ money(month.costUsd()) + ") reached the budget of $" + money(ai.monthlyBudgetUsd()),
					Map.of("limit", ai.monthlyBudgetUsd(), "spent", round(month.costUsd())));
		}
		return new Access(provider, loaded.key());
	}

	private PromptBuilder builder(Settings current) {
		return new PromptBuilder(this.index, excluded(current), current.ai().maxContextChars(), this.zone);
	}

	private static Predicate<String> excluded(Settings current) {
		return (path) -> current.ai().isExcluded(path) || current.files().isExcluded(path);
	}

	/** Validates the fields of a summary (a request, or an earlier turn when {@code strict} is false). */
	private PromptBuilder.Prompt summaryPrompt(@Nullable String actionText, @Nullable String scopeText,
			@Nullable String pathText, @Nullable List<String> pathsList, @Nullable String text,
			@Nullable String labelText, boolean strict) {
		PromptBuilder.Action action = switch ((actionText == null) ? "summarize" : actionText) {
			case "summarize" -> PromptBuilder.Action.SUMMARIZE;
			case "suggest" -> PromptBuilder.Action.SUGGEST;
			default -> throw NotesException.badRequest("action must be summarize or suggest");
		};
		PromptBuilder.Scope scope = switch ((scopeText == null) ? "" : scopeText) {
			case "note" -> PromptBuilder.Scope.NOTE;
			case "folder" -> PromptBuilder.Scope.FOLDER;
			case "notes" -> PromptBuilder.Scope.NOTES;
			case "selection" -> PromptBuilder.Scope.SELECTION;
			default -> throw NotesException.badRequest("scope must be note, folder, notes or selection");
		};
		if (action == PromptBuilder.Action.SUGGEST && scope != PromptBuilder.Scope.NOTE) {
			throw NotesException.badRequest("suggest works on a note");
		}
		String path = PromptBuilder.cleanPath(pathText);
		List<String> paths = new ArrayList<>();
		if (pathsList != null) {
			if (pathsList.size() > MAX_PATHS) {
				throw NotesException.badRequest("paths may have at most " + MAX_PATHS + " entries");
			}
			for (String p : pathsList) {
				String clean = PromptBuilder.cleanPath(p);
				if (clean != null && !paths.contains(clean)) {
					paths.add(clean);
				}
			}
		}
		String label = (labelText != null) ? labelText.strip() : null;
		if (label != null && label.length() > MAX_LABEL) {
			throw NotesException.badRequest("label must be at most " + MAX_LABEL + " characters");
		}
		if (text != null && text.length() > MAX_SELECTION) {
			throw NotesException.badRequest("text must be at most " + MAX_SELECTION + " characters");
		}
		if (strict) {
			switch (scope) {
				case NOTE -> requireNote(path, pathText);
				case FOLDER -> {
					if (path == null || !this.index.isFolder(path)) {
						throw NotesException.notFound((pathText != null) ? pathText : "");
					}
				}
				case NOTES -> {
					if (paths.isEmpty() || paths.stream().noneMatch((p) -> this.index.note(p) != null)) {
						throw NotesException.badRequest("paths must name at least one existing note");
					}
				}
				case SELECTION -> {
					if (text == null || text.isBlank()) {
						throw NotesException.badRequest("text is required for a selection");
					}
				}
			}
		}
		return new PromptBuilder.Prompt(action, null, scope, path, paths, text, label);
	}

	private void requireNote(@Nullable String path, @Nullable String raw) {
		if (path == null || this.index.file(path) == null) {
			throw NotesException.notFound((raw != null) ? raw : "");
		}
		if (this.index.note(path) == null) {
			throw new NotesException(ErrorCode.TYPE_MISMATCH, "Only notes can be summarized",
					Map.of("path", path, "expected", "note"));
		}
	}

	/** An explicitly named note, folder or selection's note in an excluded folder is refused, never quietly skipped. */
	private static void checkTarget(PromptBuilder.Prompt prompt, Predicate<String> excluded) {
		String path = prompt.path();
		if (path != null && prompt.scope() != PromptBuilder.Scope.NOTES && excluded.test(path)) {
			throw new NotesException(ErrorCode.AI_EXCLUDED,
					"This is in a folder excluded from Ask and summaries (Settings)", Map.of("path", path));
		}
	}

	// ---------------------------------------------------------------- history

	private record History(List<PromptBuilder.Turn> turns, List<String> answers, Set<String> sentPaths) {

		int chars() {
			return this.turns.stream().mapToInt(PromptBuilder.Turn::chars).sum();
		}

	}

	private History history(PromptBuilder builder, @Nullable List<AiTurn> history) {
		if (history == null || history.isEmpty()) {
			return new History(List.of(), List.of(), Set.of());
		}
		if (history.size() > MAX_HISTORY) {
			throw NotesException.badRequest("history may have at most " + MAX_HISTORY + " turns");
		}
		List<AiTurn> recent = history.subList(Math.max(0, history.size() - HISTORY_TURNS), history.size());
		List<PromptBuilder.Turn> turns = new ArrayList<>();
		List<String> answers = new ArrayList<>();
		Set<String> sent = new LinkedHashSet<>();
		for (AiTurn turn : recent) {
			if (turn == null || turn.prompt() == null) {
				throw NotesException.badRequest("every history turn needs a prompt");
			}
			String answer = (turn.answer() != null) ? turn.answer() : "";
			if (answer.length() > MAX_ANSWER) {
				throw NotesException.badRequest("a history answer may have at most " + MAX_ANSWER + " characters");
			}
			List<String> sources = new ArrayList<>();
			if (turn.sources() != null) {
				if (turn.sources().size() > MAX_PATHS) {
					throw NotesException.badRequest("a history turn may have at most " + MAX_PATHS + " sources");
				}
				for (String source : turn.sources()) {
					String clean = PromptBuilder.cleanPath(source);
					if (clean != null && !sources.contains(clean)) {
						sources.add(clean);
					}
				}
			}
			PromptBuilder.Turn rebuilt = builder.rebuild(historyPrompt(turn.prompt()), sources, !sent.isEmpty());
			turns.add(rebuilt);
			answers.add(answer);
			rebuilt.sources().forEach((s) -> sent.add(s.path()));
		}
		return new History(turns, answers, sent);
	}

	private PromptBuilder.Prompt historyPrompt(AiPrompt prompt) {
		if ("ask".equals(prompt.action()) || prompt.action() == null) {
			String question = (prompt.question() != null) ? prompt.question().strip() : "";
			if (question.length() > MAX_QUESTION) {
				throw NotesException.badRequest("question must be at most " + MAX_QUESTION + " characters");
			}
			return PromptBuilder.Prompt.ask(question);
		}
		return summaryPrompt(prompt.action(), prompt.scope(), prompt.path(), prompt.paths(), prompt.text(),
				prompt.label(), false);
	}

	// ---------------------------------------------------------------- running

	/**
	 * Streams the answer: {@code start}, then {@code delta}s (and a {@code restart} when a fallback model takes over),
	 * then {@code done} or {@code error}. Records the estimated cost, also when the browser goes away part way.
	 */
	public void run(Prepared prepared, Sink sink, @Nullable String client) {
		if (!this.running.tryAcquire()) {
			sink.send("error", new AiErrorEvent("busy", "Another answer is still being written; try again shortly"));
			return;
		}
		long started = System.nanoTime();
		int[] streamed = { 0 };
		boolean upstream = false;
		boolean recorded = false;
		try {
			sink.send("start", prepared.start());
			upstream = true;
			ClaudeGateway.Result result = prepared.gateway().stream(prepared.request(), new ClaudeGateway.Listener() {

				@Override
				public void onText(String text) {
					streamed[0] += text.length();
					sink.send("delta", new AiDeltaEvent(text));
				}

				@Override
				public void onRestart(String model) {
					streamed[0] = 0;
					sink.send("restart", new AiRestartEvent(model));
				}

			});
			double cost = result.cost();
			UsageLedger.Month month = this.ledger.record(cost, result.usage());
			recorded = true;
			AiModels.Usage u = result.usage();
			log(prepared, client, result.model(), u, cost, month, result.stopReason(), started);
			sink.send("done", new AiDoneEvent(result.model(), result.stopReason(), result.refusalCategory(),
					result.fellBack(), new AiUsage(u.inputTokens(), u.outputTokens(), u.cacheReadInputTokens(),
							u.cacheCreationInputTokens()),
					round(cost), round(month.costUsd())));
		}
		catch (ClientGoneException ex) {
			if (!upstream || recorded) {
				return;
			}
			// The stream was closed upstream when the exception left the gateway; what was generated is still paid.
			AiModels.Usage estimate = estimate(prepared.request(), streamed[0]);
			double cost = AiModels.of(prepared.request().model()).cost(estimate);
			UsageLedger.Month month = this.ledger.record(cost, estimate);
			log(prepared, client, prepared.request().model(), estimate, cost, month, "cancelled", started);
		}
		catch (ClaudeException ex) {
			logger.warn("AI {} failed: {} ({}) client={}", prepared.kind(), ex.kind(), ex.getMessage(), client);
			sendQuietly(sink, "error", new AiErrorEvent(code(ex.kind()), ex.getMessage()));
		}
		catch (RuntimeException ex) {
			String incident = Long.toString(System.nanoTime(), 36);
			logger.error("AI {} failed unexpectedly, incident {}", prepared.kind(), incident, ex);
			sendQuietly(sink, "error", new AiErrorEvent("internal-error", "Something went wrong (incident " + incident
					+ ")"));
		}
		finally {
			this.running.release();
		}
	}

	private void log(Prepared prepared, @Nullable String client, String model, AiModels.Usage usage, double cost,
			UsageLedger.Month month, String stop, long started) {
		logger.info("AI {} model={} notes={} history={} in={} out={} cacheRead={} cacheWrite={} cost=${} month=${} "
				+ "stop={} {}ms client={}", prepared.kind(), model, prepared.start().sources().size(),
				prepared.historyTurns(), usage.inputTokens(), usage.outputTokens(), usage.cacheReadInputTokens(),
				usage.cacheCreationInputTokens(), money4(cost), money(month.costUsd()), stop,
				(System.nanoTime() - started) / 1_000_000, client);
	}

	/** About four characters per token: the request in full, and the answer written so far plus as much thinking. */
	private static AiModels.Usage estimate(ClaudeGateway.Request request, int streamedChars) {
		int input = request.system().length()
				+ request.messages().stream().mapToInt(ClaudeGateway.Message::chars).sum();
		return new AiModels.Usage(input / 4, streamedChars / 2, 0, 0);
	}

	private static void sendQuietly(Sink sink, String event, Object data) {
		try {
			sink.send(event, data);
		}
		catch (ClientGoneException ex) {
			// Nobody is listening any more.
		}
	}

	static String code(ClaudeException.Kind kind) {
		return switch (kind) {
			case AUTH -> "auth";
			case RATE_LIMITED -> "rate-limited";
			case OVERLOADED -> "overloaded";
			case BAD_REQUEST -> "bad-request";
			case UNAVAILABLE -> "unavailable";
		};
	}

	private static double round(double usd) {
		return Math.round(usd * 1_000_000) / 1_000_000.0;
	}

	private static String money(double usd) {
		return String.format(Locale.ROOT, "%.2f", usd);
	}

	private static String money4(double usd) {
		return String.format(Locale.ROOT, "%.4f", usd);
	}

}
