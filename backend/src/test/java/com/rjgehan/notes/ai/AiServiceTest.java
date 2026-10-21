package com.rjgehan.notes.ai;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

import com.rjgehan.notes.ai.ClaudeGateway.ClaudeException;
import com.rjgehan.notes.api.dto.AiAskRequest;
import com.rjgehan.notes.api.dto.AiDoneEvent;
import com.rjgehan.notes.api.dto.AiErrorEvent;
import com.rjgehan.notes.api.dto.AiPrompt;
import com.rjgehan.notes.api.dto.AiSource;
import com.rjgehan.notes.api.dto.AiStartEvent;
import com.rjgehan.notes.api.dto.AiState;
import com.rjgehan.notes.api.dto.AiSummarizeRequest;
import com.rjgehan.notes.api.dto.AiTurn;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.support.TestVault;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Ask your vault and summaries end to end below HTTP: availability, retrieval, exclusions, the prompt and its cache
 * prefix, the stream of events and the spend guard. The Claude API is replaced by a recording gateway; nothing leaves
 * the machine.
 */
class AiServiceTest {

	@TempDir
	Path dir;

	@TempDir
	Path secrets;

	private TestVault vault;

	private UsageLedger ledger;

	private final RecordingGateway gateway = new RecordingGateway();

	private AiService service;

	private boolean cliInstalled = true;

	/** Records requests and answers with a fixed text, or with what a test sets. */
	static final class RecordingGateway implements ClaudeGateway {

		final List<Request> requests = new CopyOnWriteArrayList<>();

		volatile List<String> pieces = List.of("The budget ", "is 12k [[Projects/Kitchen]].");

		volatile @Nullable ClaudeException failure;

		@Override
		public Result stream(Request request, Listener listener) throws ClaudeException {
			this.requests.add(request);
			if (this.failure != null) {
				throw this.failure;
			}
			for (String piece : this.pieces) {
				listener.onText(piece);
			}
			return new Result(request.model(), "end_turn", null,
					List.of(new Hop(request.model(), new AiModels.Usage(10_000, 500, 0, 0))), false);
		}

		String lastUserText() {
			Request request = this.requests.get(this.requests.size() - 1);
			return text(request.messages().get(request.messages().size() - 1));
		}

	}

	record Event(String name, Object data) {
	}

	static String text(ClaudeGateway.Message message) {
		return message.blocks().stream().map(ClaudeGateway.Block::text).reduce("", String::concat);
	}

	@BeforeEach
	void setUp() throws Exception {
		write("Projects/Kitchen.md", "# Kitchen renovation\n\nThe budget for the kitchen is 12k.\n\nTiles arrive Monday.");
		write("Projects/Garden.md", "# Garden\n\nPlant tomatoes and basil. #garden");
		write("Private/Diary.md", "The kitchen budget worries me. Secret diary entry.");
		write("Archive/Old kitchen.md", "Old kitchen budget notes, archived.");
		write("Recipes/Soup.md", "Tomato soup. #cooking");
		this.vault = TestVault.start(this.dir);
		this.vault.settings.load();
		this.ledger = new UsageLedger(this.vault.fs, this.vault.clock, TestVault.JSON, ZoneOffset.UTC);
		this.service = service(false);
	}

	@AfterEach
	void tearDown() {
		this.vault.close();
	}

	private AiService service(boolean fake) {
		return service(fake, this.gateway);
	}

	private AiService service(boolean fake, ClaudeGateway gateway) {
		AiProperties properties = new AiProperties("", "claude", "", "", fake, 16000, "medium", Duration.ofMinutes(5), 2);
		AiProviders providers = new AiProviders(fake,
				new AiProviders.Provider("claude-code", gateway,
						new ApiKeyFile(this.secrets.resolve("claude-token"), "Claude Code token")),
				new AiProviders.Provider("api", gateway, new ApiKeyFile(this.secrets.resolve("anthropic-key"), "API key")),
				() -> this.cliInstalled, "claude");
		return new AiService(this.vault.index, this.vault.settings, providers, this.ledger, properties, this.vault.clock);
	}

	private void write(String path, String text) throws Exception {
		Path file = this.dir.resolve(path);
		Files.createDirectories(file.getParent());
		Files.writeString(file, text);
	}

	private void key() throws Exception {
		Files.writeString(this.secrets.resolve("claude-token"), "sk-ant-oat01-test-token\n");
	}

	/** Turns the feature on, with optional changes to {@code settings.ai} and {@code settings.files}. */
	private void enable(Consumer<ObjectNode> ai, Consumer<ObjectNode> files) throws Exception {
		ObjectNode tree = (ObjectNode) TestVault.JSON.valueToTree(this.vault.settings.current());
		ObjectNode aiNode = (ObjectNode) tree.get("ai");
		aiNode.put("enabled", true);
		ai.accept(aiNode);
		files.accept((ObjectNode) tree.get("files"));
		this.vault.settings.update(tree, this.vault.settings.get().version(), TestVault.ALICE, "client-a1");
	}

	private void enable() throws Exception {
		enable((ai) -> {
		}, (files) -> {
		});
	}

	private List<Event> run(AiService.Prepared prepared) {
		List<Event> events = new ArrayList<>();
		this.service.run(prepared, (name, data) -> events.add(new Event(name, data)), "client-a1");
		return events;
	}

	private static List<String> paths(AiStartEvent start) {
		return start.sources().stream().map(AiSource::path).toList();
	}

	// ---------------------------------------------------------------- availability

	@Test
	void offByDefaultAndNothingIsSent() throws Exception {
		key();
		assertThat(this.service.status().state()).isEqualTo(AiState.OFF);
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("Kitchen budget?", null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.AI_UNAVAILABLE);
				assertThat(ex.getBody().getProperties()).containsEntry("reason", "off");
			});
		assertThat(this.gateway.requests).isEmpty();
	}

	@Test
	void withoutAKeyFileItIsNotConfigured() throws Exception {
		enable();
		assertThat(this.service.status().state()).isEqualTo(AiState.NOT_CONFIGURED);
		assertThat(this.service.status().reason()).contains("claude-token does not exist");
		assertThat(this.service.status().keyPresent()).isFalse();
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("Kitchen budget?", null, null)))
			.isInstanceOfSatisfying(NotesException.class,
					(ex) -> assertThat(ex.getBody().getProperties()).containsEntry("reason", "not-configured"));
	}

	@Test
	void anEmptyKeyFileIsNotAKey() throws Exception {
		enable();
		Files.writeString(this.secrets.resolve("claude-token"), "  \n");
		assertThat(this.service.status().reason()).contains("is empty");
	}

	@Test
	void claudeCodeIsTheDefaultAndNeedsTheCli() throws Exception {
		key();
		enable();
		assertThat(this.service.status().provider()).isEqualTo("claude-code");
		assertThat(this.service.status().keyFile()).isEqualTo("claude-token");
		this.cliInstalled = false;
		assertThat(this.service.status().state()).isEqualTo(AiState.NOT_CONFIGURED);
		assertThat(this.service.status().reason()).contains("Claude Code CLI (claude) is not installed");
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("Kitchen budget?", null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.getMessage()).contains("Claude Code"));
	}

	@Test
	void theApiProviderUsesTheApiKeyAndTheServerSideFallback() throws Exception {
		Files.writeString(this.secrets.resolve("anthropic-key"), "sk-ant-api03-test-key\n");
		enable((ai) -> ai.put("provider", "api"), (files) -> {
		});
		this.cliInstalled = false;
		assertThat(this.service.status().state()).isEqualTo(AiState.READY);
		assertThat(this.service.status().keyFile()).isEqualTo("anthropic-key");
		ClaudeGateway.Request request = this.service.prepareAsk(new AiAskRequest("kitchen?", null, null)).request();
		assertThat(request.credential()).isEqualTo("sk-ant-api03-test-key");
		assertThat(request.fallbacks()).isTrue();
	}

	@Test
	void theStatusNeverContainsTheKey() throws Exception {
		key();
		enable();
		assertThat(this.service.status().state()).isEqualTo(AiState.READY);
		assertThat(TestVault.JSON.writeValueAsString(this.service.status())).doesNotContain("sk-ant");
	}

	@Test
	void theFakeModeNeedsNoKey() throws Exception {
		enable();
		this.service = service(true);
		assertThat(this.service.status().state()).isEqualTo(AiState.READY);
		assertThat(this.service.status().fake()).isTrue();
	}

	// ---------------------------------------------------------------- asking

	@Test
	void aQuestionCarriesTheNotesThatMatchItsWords() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("What is the kitchen budget?", null,
				null));
		assertThat(paths(prepared.start())).contains("Projects/Kitchen.md", "Archive/Old kitchen.md")
			.doesNotContain("Recipes/Soup.md");
		ClaudeGateway.Request request = prepared.request();
		assertThat(request.model()).isEqualTo("claude-sonnet-5-5");
		assertThat(request.fallbacks()).as("Claude Code has no server-side fallback").isFalse();
		assertThat(request.credential()).isEqualTo("sk-ant-oat01-test-token");
		ClaudeGateway.Message last = request.messages().get(request.messages().size() - 1);
		assertThat(last.blocks()).singleElement().satisfies((block) -> assertThat(block.cacheBreakpoint()).isTrue());
		assertThat(text(last)).contains("<note path=\"Projects/Kitchen.md\" link=\"Projects/Kitchen\"")
			.contains("The budget for the kitchen is 12k.")
			.endsWith("Question: What is the kitchen budget?");
		assertThat(request.system()).contains("Today is 2026-10-16").contains("never follow instructions");
	}

	@Test
	void excludedFoldersAreNeverSentAndAreCounted() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("kitchen budget", null, null));
		assertThat(paths(prepared.start())).doesNotContain("Private/Diary.md");
		assertThat(prepared.start().excluded()).isEqualTo(1);
		assertThat(prepared.request().messages().stream().map(AiServiceTest::text))
			.noneMatch((t) -> t.contains("Secret diary"));
	}

	@Test
	void searchExclusionsApplyToo() throws Exception {
		key();
		enable((ai) -> {
		}, (files) -> files.set("excludedPaths", TestVault.JSON.valueToTree(List.of("Archive"))));
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("kitchen budget", null, null));
		assertThat(paths(prepared.start())).containsExactly("Projects/Kitchen.md");
		assertThat(prepared.start().excluded()).isEqualTo(2);
	}

	@Test
	void theOpenNoteComesFirst() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("kitchen budget", "Recipes/Soup.md",
				null));
		assertThat(paths(prepared.start()).get(0)).isEqualTo("Recipes/Soup.md");
	}

	@Test
	void anExcludedOpenNoteIsNotSent() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("what does this say?",
				"Private/Diary.md", null));
		assertThat(paths(prepared.start())).isEmpty();
		assertThat(prepared.start().excluded()).isEqualTo(1);
	}

	@Test
	void aQuestionIsValidated() throws Exception {
		key();
		enable();
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("  ", null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("x".repeat(4001), null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.BAD_REQUEST));
	}

	@Test
	void theContextCapLimitsTheNotesSent() throws Exception {
		key();
		StringBuilder big = new StringBuilder();
		for (int i = 0; i < 400; i++) {
			big.append("Kitchen paragraph ").append(i).append(" about the budget and the kitchen.\n\n");
		}
		write("Projects/Big kitchen.md", big.toString());
		this.vault.builder.build();
		enable((ai) -> ai.put("maxContextChars", 8000), (files) -> {
		});
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("kitchen budget", null, null));
		int chars = prepared.start().sources().stream().mapToInt(AiSource::chars).sum();
		assertThat(chars).isLessThanOrEqualTo(8000);
		assertThat(prepared.start().sources()).anySatisfy((s) -> {
			assertThat(s.path()).isEqualTo("Projects/Big kitchen.md");
			assertThat(s.truncated()).isTrue();
		});
	}

	// ---------------------------------------------------------------- conversations

	@Test
	void anEarlierTurnIsRebuiltByteForByteSoItsPrefixIsCached() throws Exception {
		key();
		enable();
		AiService.Prepared first = this.service.prepareAsk(new AiAskRequest("What is the kitchen budget?", null,
				null));
		String firstText = text(first.request().messages().get(0));
		AiTurn turn = new AiTurn(new AiPrompt("ask", "What is the kitchen budget?", null, null, null, null, null),
				"It is 12k [[Projects/Kitchen]].", paths(first.start()));
		AiService.Prepared second = this.service.prepareAsk(new AiAskRequest("And when do the tiles arrive?", null,
				List.of(turn)));
		List<ClaudeGateway.Message> messages = second.request().messages();
		assertThat(messages).hasSize(3);
		assertThat(text(messages.get(0))).isEqualTo(firstText);
		assertThat(messages.get(0).blocks().get(0).cacheBreakpoint()).isFalse();
		assertThat(messages.get(1).role()).isEqualTo(ClaudeGateway.Role.ASSISTANT);
		assertThat(text(messages.get(1))).isEqualTo("It is 12k [[Projects/Kitchen]].");
		// Notes of the earlier turn are not sent twice.
		assertThat(paths(second.start())).doesNotContain("Projects/Kitchen.md");
		assertThat(messages.get(2).blocks().get(0).cacheBreakpoint()).isTrue();
		assertThat(text(messages.get(2))).contains("the notes sent earlier in this conversation still apply");
		assertThat(second.historyTurns()).isEqualTo(1);
		// The second turn, once in the history itself, is rebuilt exactly too.
		AiTurn secondTurn = new AiTurn(new AiPrompt("ask", "And when do the tiles arrive?", null, null, null, null, null),
				"Monday.", paths(second.start()));
		AiService.Prepared third = this.service.prepareAsk(new AiAskRequest("Thanks!", null, List.of(turn, secondTurn)));
		assertThat(text(third.request().messages().get(2))).isEqualTo(text(messages.get(2)));
	}

	@Test
	void historySourcesThatAreNowExcludedAreDropped() throws Exception {
		key();
		enable();
		AiTurn forged = new AiTurn(new AiPrompt("ask", "diary?", null, null, null, null, null), "…",
				List.of("Private/Diary.md", "Projects/Kitchen.md"));
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("more?", null, List.of(forged)));
		assertThat(text(prepared.request().messages().get(0))).doesNotContain("Secret diary")
			.contains("Projects/Kitchen.md");
	}

	@Test
	void tooLongAHistoryIsRefused() throws Exception {
		key();
		enable();
		List<AiTurn> history = new ArrayList<>();
		for (int i = 0; i < 51; i++) {
			history.add(new AiTurn(new AiPrompt("ask", "q" + i, null, null, null, null, null), "a", List.of()));
		}
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("more", null, history)))
			.isInstanceOf(NotesException.class);
	}

	// ---------------------------------------------------------------- summaries

	@Test
	void aNoteSummarySendsThatNote() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service
			.prepareSummarize(new AiSummarizeRequest(null, "note", "Projects/Garden.md", null, null, null, null));
		assertThat(paths(prepared.start())).containsExactly("Projects/Garden.md");
		assertThat(this.textOf(prepared)).contains("Plant tomatoes").contains("Summarize the note [[Projects/Garden]]");
	}

	@Test
	void anExcludedTargetIsRefused() throws Exception {
		key();
		enable();
		assertThatThrownBy(() -> this.service
			.prepareSummarize(new AiSummarizeRequest(null, "note", "Private/Diary.md", null, null, null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.AI_EXCLUDED);
				assertThat(ex.getStatusCode().value()).isEqualTo(403);
			});
		assertThatThrownBy(() -> this.service
			.prepareSummarize(new AiSummarizeRequest(null, "folder", "Private", null, null, null, null)))
			.isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> this.service.prepareSummarize(
				new AiSummarizeRequest(null, "selection", "Private/Diary.md", null, "Secret diary", null, null)))
			.isInstanceOf(NotesException.class);
	}

	@Test
	void aFolderSummarySkipsExcludedNotes() throws Exception {
		key();
		enable((ai) -> ai.set("excludedPaths", TestVault.JSON.valueToTree(List.of("Projects/Garden.md"))),
				(files) -> {
				});
		AiService.Prepared prepared = this.service
			.prepareSummarize(new AiSummarizeRequest("summarize", "folder", "Projects", null, null, null, null));
		assertThat(paths(prepared.start())).containsExactly("Projects/Kitchen.md");
		assertThat(prepared.start().excluded()).isEqualTo(1);
		assertThat(textOf(prepared)).doesNotContain("tomatoes").contains("the folder \"Projects\"");
	}

	@Test
	void notesByPathWithALabel() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareSummarize(new AiSummarizeRequest(null, "notes", null,
				List.of("Recipes/Soup.md", "Daily/2026-10-20.md", "Projects/Garden.md"), null, "this week's daily notes",
				null));
		assertThat(paths(prepared.start())).containsExactly("Recipes/Soup.md", "Projects/Garden.md");
		assertThat(textOf(prepared)).contains("(this week's daily notes)");
	}

	@Test
	void aSelectionSendsOnlyTheSelection() throws Exception {
		key();
		enable();
		AiService.Prepared prepared = this.service.prepareSummarize(
				new AiSummarizeRequest(null, "selection", "Projects/Kitchen.md", null, "Tiles arrive Monday.", null, null));
		assertThat(prepared.start().sources()).isEmpty();
		assertThat(textOf(prepared)).contains("<selection>\nTiles arrive Monday.\n</selection>")
			.doesNotContain("12k")
			.contains("from [[Projects/Kitchen]]");
	}

	@Test
	void suggestOffersRelatedNotesAndVisibleTagsOnly() throws Exception {
		key();
		write("Projects/Kitchen tiles.md", "Kitchen tiles supplier and budget. #renovation");
		write("Private/Kitchen secret.md", "kitchen kitchen budget #secret-tag");
		this.vault.builder.build();
		enable();
		AiService.Prepared prepared = this.service
			.prepareSummarize(new AiSummarizeRequest("suggest", "note", "Projects/Kitchen.md", null, null, null, null));
		String text = textOf(prepared);
		assertThat(text).contains("<candidates>").contains("[[Projects/Kitchen tiles]]")
			.doesNotContain("Kitchen secret")
			.contains("#renovation")
			.doesNotContain("#secret-tag");
	}

	@Test
	void summariesAreValidated() throws Exception {
		key();
		enable();
		assertThatThrownBy(() -> this.service
			.prepareSummarize(new AiSummarizeRequest(null, "galaxy", "Projects/Kitchen.md", null, null, null, null)))
			.isInstanceOf(NotesException.class);
		assertThatThrownBy(() -> this.service
			.prepareSummarize(new AiSummarizeRequest(null, "note", "Nope.md", null, null, null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> assertThat(ex.code()).isEqualTo(ErrorCode.NOT_FOUND));
		assertThatThrownBy(() -> this.service
			.prepareSummarize(new AiSummarizeRequest("suggest", "folder", "Projects", null, null, null, null)))
			.isInstanceOf(NotesException.class);
	}

	private String textOf(AiService.Prepared prepared) {
		List<ClaudeGateway.Message> messages = prepared.request().messages();
		return text(messages.get(messages.size() - 1));
	}

	// ---------------------------------------------------------------- running and spending

	@Test
	void theAnswerStreamsAndItsCostIsRecorded() throws Exception {
		key();
		enable();
		List<Event> events = run(this.service.prepareAsk(new AiAskRequest("kitchen budget?", null, null)));
		assertThat(events).extracting(Event::name).containsExactly("start", "delta", "delta", "done");
		AiDoneEvent done = (AiDoneEvent) events.get(3).data();
		// 10,000 input tokens at $2 and 500 output tokens at $10 per million.
		assertThat(done.costUsd()).isEqualTo(0.025);
		assertThat(done.monthCostUsd()).isEqualTo(0.025);
		assertThat(done.stopReason()).isEqualTo("end_turn");
		assertThat(this.service.status().monthCostUsd()).isEqualTo(0.025);
		assertThat(this.service.status().monthRequests()).isEqualTo(1);
		String ledger = Files.readString(this.dir.resolve(UsageLedger.FILE));
		assertThat(ledger).contains("\"2026-10\"").doesNotContain("kitchen");
	}

	@Test
	void theMonthlyBudgetStopsRequests() throws Exception {
		key();
		enable((ai) -> ai.put("monthlyBudgetUsd", 0.03), (files) -> {
		});
		run(this.service.prepareAsk(new AiAskRequest("kitchen budget?", null, null)));
		run(this.service.prepareAsk(new AiAskRequest("kitchen budget?", null, null)));
		assertThat(this.service.status().state()).isEqualTo(AiState.OVER_BUDGET);
		assertThatThrownBy(() -> this.service.prepareAsk(new AiAskRequest("kitchen budget?", null, null)))
			.isInstanceOfSatisfying(NotesException.class, (ex) -> {
				assertThat(ex.code()).isEqualTo(ErrorCode.AI_BUDGET_EXCEEDED);
				assertThat(ex.getStatusCode().value()).isEqualTo(429);
				assertThat(ex.getBody().getProperties()).containsEntry("limit", 0.03);
			});
		// A new month starts from zero.
		this.vault.clock.advance(Duration.ofDays(20));
		assertThat(this.service.status().state()).isEqualTo(AiState.READY);
	}

	@Test
	void anApiErrorBecomesAnErrorEvent() throws Exception {
		key();
		enable();
		this.gateway.failure = new ClaudeException(ClaudeException.Kind.AUTH, "The Claude API refused the API key");
		List<Event> events = run(this.service.prepareAsk(new AiAskRequest("kitchen?", null, null)));
		assertThat(events).extracting(Event::name).containsExactly("start", "error");
		assertThat(((AiErrorEvent) events.get(1).data()).code()).isEqualTo("auth");
		assertThat(this.service.status().monthRequests()).isZero();
	}

	@Test
	void aBrowserThatLeavesStopsTheAnswerAndItsPartIsStillCounted() throws Exception {
		key();
		enable();
		this.gateway.pieces = List.of("one ", "two ", "three");
		AiService.Prepared prepared = this.service.prepareAsk(new AiAskRequest("kitchen?", null, null));
		List<String> sent = new ArrayList<>();
		this.service.run(prepared, (name, data) -> {
			if (name.equals("delta") && sent.contains("delta")) {
				throw new AiService.ClientGoneException(new java.io.IOException("closed"));
			}
			sent.add(name);
		}, "client-a1");
		assertThat(sent).containsExactly("start", "delta");
		assertThat(this.service.status().monthRequests()).isEqualTo(1);
		assertThat(this.service.status().monthCostUsd()).isPositive();
	}

	@Test
	void theFakeGatewayCitesTheNotesItWasGiven() throws Exception {
		enable();
		AiService fake = service(true, new FakeGateway(0));
		List<Event> events = new ArrayList<>();
		fake.run(fake.prepareAsk(new AiAskRequest("kitchen budget", null, null)),
				(name, data) -> events.add(new Event(name, data)), "c");
		String answer = events.stream()
			.filter((e) -> e.name().equals("delta"))
			.map((e) -> ((com.rjgehan.notes.api.dto.AiDeltaEvent) e.data()).text())
			.reduce("", String::concat);
		assertThat(answer).contains("[[Projects/Kitchen]]").contains("notes.ai.fake");
		assertThat(events.get(events.size() - 1).name()).isEqualTo("done");
	}

	@Test
	void settingsKeepTheAiGroupInTheFile() throws Exception {
		enable((ai) -> ai.put("model", "claude-opus-5-5"), (files) -> {
		});
		String file = Files.readString(this.dir.resolve(".notesapp/settings.json"));
		assertThat(file).contains("\"ai\"").contains("claude-opus-5-5");
		ArrayNode excluded = (ArrayNode) TestVault.JSON.readTree(file).get("ai").get("excludedPaths");
		assertThat(excluded.get(0).asString()).isEqualTo("Private");
		assertThat(this.service.status().model()).isEqualTo("claude-opus-5-5");
	}

}
