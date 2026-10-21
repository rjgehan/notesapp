package com.rjgehan.notes.ai;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.ai.ClaudeGateway.Block;
import com.rjgehan.notes.ai.ClaudeGateway.ClaudeException;
import com.rjgehan.notes.ai.ClaudeGateway.Message;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The Claude Code provider with the CLI replaced by a fake process: the command line and environment of a run, the
 * stream-json lines it reads, errors, cancellation and the timeout. No process is started and nothing is sent.
 */
class ClaudeCodeGatewayTest {

	private static final String TOKEN = "sk-ant-oat01-test-token-0123";

	@TempDir
	Path dir;

	private Path executable;

	private Path work;

	/** What the fake launcher was given, and the process it returned. */
	private final List<List<String>> commands = new ArrayList<>();

	private final List<Map<String, String>> environments = new ArrayList<>();

	private final List<Path> directories = new ArrayList<>();

	private @Nullable FakeProcess process;

	@BeforeEach
	void setUp() throws IOException {
		this.executable = Files.createFile(this.dir.resolve("claude"));
		this.executable.toFile().setExecutable(true);
		this.work = this.dir.resolve("work");
	}

	/** A process whose output is fixed, or held open until it is killed. */
	static final class FakeProcess extends Process {

		final ByteArrayOutputStream stdin = new ByteArrayOutputStream();

		private final InputStream stdout;

		private final InputStream stderr;

		private final @Nullable PipedOutputStream hold;

		private final int exit;

		private final CountDownLatch ended;

		volatile boolean killed;

		FakeProcess(String stdout, String stderr, int exit) {
			this.stdout = new ByteArrayInputStream(stdout.getBytes(StandardCharsets.UTF_8));
			this.stderr = new ByteArrayInputStream(stderr.getBytes(StandardCharsets.UTF_8));
			this.hold = null;
			this.exit = exit;
			this.ended = new CountDownLatch(0);
		}

		/** Never ends by itself. */
		FakeProcess() throws IOException {
			this.hold = new PipedOutputStream();
			this.stdout = new PipedInputStream(this.hold);
			this.stderr = new ByteArrayInputStream(new byte[0]);
			this.exit = 143;
			this.ended = new CountDownLatch(1);
		}

		@Override
		public OutputStream getOutputStream() {
			return this.stdin;
		}

		@Override
		public InputStream getInputStream() {
			return this.stdout;
		}

		@Override
		public InputStream getErrorStream() {
			return this.stderr;
		}

		@Override
		public int waitFor() throws InterruptedException {
			this.ended.await();
			return this.exit;
		}

		@Override
		public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
			return this.ended.await(timeout, unit);
		}

		@Override
		public int exitValue() {
			return this.exit;
		}

		@Override
		public void destroy() {
			this.killed = true;
			this.ended.countDown();
			if (this.hold != null) {
				try {
					this.hold.close();
				}
				catch (IOException ex) {
					// closed
				}
			}
		}

		@Override
		public Process destroyForcibly() {
			destroy();
			return this;
		}

		@Override
		public boolean isAlive() {
			return this.ended.getCount() > 0;
		}

	}

	private ClaudeCodeGateway gateway(FakeProcess fake, Duration timeout) {
		this.process = fake;
		return new ClaudeCodeGateway(this.executable.toString(), this.work, timeout, (command, env, directory) -> {
			this.commands.add(command);
			this.environments.add(env);
			this.directories.add(directory);
			return fake;
		});
	}

	private static ClaudeGateway.Request request(Message... messages) {
		return new ClaudeGateway.Request(TOKEN, "claude-sonnet-5-5", "System prompt", List.of(messages), 16000,
				"medium", false);
	}

	private static ClaudeGateway.Request question() {
		return request(Message.user(new Block("<notes/>\n\nQuestion: budget?", true)));
	}

	private static String lines(String... lines) {
		return String.join("\n", lines) + "\n";
	}

	private static final String INIT = "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-sonnet-5-5\",\"tools\":[]}";

	private static String delta(String text) {
		return "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,"
				+ "\"delta\":{\"type\":\"text_delta\",\"text\":\"" + text + "\"}},\"parent_tool_use_id\":null}";
	}

	private static final String ASSISTANT = "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5-5\","
			+ "\"content\":[{\"type\":\"text\",\"text\":\"Hello [[A]]\"}]},\"parent_tool_use_id\":null}";

	private static final String RESULT = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,"
			+ "\"num_turns\":1,\"result\":\"Hello [[A]]\",\"total_cost_usd\":0.0123,\"stop_reason\":\"end_turn\","
			+ "\"usage\":{\"input_tokens\":1200,\"output_tokens\":40,\"cache_read_input_tokens\":300,"
			+ "\"cache_creation_input_tokens\":0},\"modelUsage\":{\"claude-sonnet-5-5\":{\"inputTokens\":1200}}}";

	@Test
	void streamsTheTextAndReportsUsageAndTheReportedCost() throws Exception {
		List<String> texts = new ArrayList<>();
		ClaudeGateway.Result result = gateway(new FakeProcess(lines(INIT, delta("Hello "), delta("[[A]]"), ASSISTANT,
				RESULT), "", 0), Duration.ofMinutes(1)).stream(question(), texts::add);
		assertThat(texts).containsExactly("Hello ", "[[A]]");
		assertThat(result.model()).isEqualTo("claude-sonnet-5-5");
		assertThat(result.stopReason()).isEqualTo("end_turn");
		assertThat(result.usage()).isEqualTo(new AiModels.Usage(1200, 40, 300, 0));
		assertThat(result.cost()).isEqualTo(0.0123);
		assertThat(this.process.stdin.toString(StandardCharsets.UTF_8)).isEqualTo("<notes/>\n\nQuestion: budget?");
	}

	@Test
	void theRunIsLockedDown() throws Exception {
		gateway(new FakeProcess(lines(INIT, RESULT), "", 0), Duration.ofMinutes(1)).stream(question(), (t) -> {
		});
		List<String> command = this.commands.get(0);
		assertThat(command.get(0)).isEqualTo(this.executable.toString());
		assertThat(command).containsSequence("-p", "--output-format", "stream-json", "--verbose",
			"--include-partial-messages");
		assertThat(command).containsSequence("--tools", "");
		assertThat(command).containsSequence("--model", "claude-sonnet-5-5");
		assertThat(command).containsSequence("--system-prompt", "System prompt");
		assertThat(command).contains("--no-session-persistence", "--strict-mcp-config");
		assertThat(String.join(" ", command)).doesNotContain(TOKEN);
		Map<String, String> env = this.environments.get(0);
		assertThat(env).containsEntry("CLAUDE_CODE_OAUTH_TOKEN", TOKEN);
		assertThat(env.keySet()).doesNotContain("ANTHROPIC_API_KEY", "NOTES_AI_CLAUDE_TOKEN_FILE");
		Path home = Path.of(env.get("HOME"));
		assertThat(home.getParent()).isEqualTo(this.work);
		assertThat(this.directories.get(0)).isEqualTo(home);
		assertThat(home).as("the run's home is deleted afterwards").doesNotExist();
	}

	@Test
	void earlierTurnsBecomeATranscriptBeforeTheNewMessage() {
		String prompt = ClaudeCodeGateway.prompt(request(Message.user(new Block("First question", false)),
				Message.assistant("First answer"), Message.user(new Block("Second question", true))));
		assertThat(prompt).startsWith("<earlier_turns>\n<user>\nFirst question\n</user>\n<assistant>\nFirst answer\n")
			.endsWith("Second question");
	}

	@Test
	void anOlderCliWithoutPartialMessagesStillAnswers() throws Exception {
		List<String> texts = new ArrayList<>();
		gateway(new FakeProcess(lines(INIT, ASSISTANT, RESULT), "", 0), Duration.ofMinutes(1)).stream(question(),
				texts::add);
		assertThat(texts).containsExactly("Hello [[A]]");
	}

	@Test
	void aRefusedTokenIsAnAuthErrorWithoutTheToken() {
		String error = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,"
				+ "\"result\":\"Invalid API key · Please run /login (" + TOKEN + ")\"}";
		assertThatThrownBy(() -> gateway(new FakeProcess(lines(INIT, error), "", 1), Duration.ofMinutes(1))
			.stream(question(), (t) -> {
			}))
			.isInstanceOfSatisfying(ClaudeException.class, (ex) -> {
				assertThat(ex.kind()).isEqualTo(ClaudeException.Kind.AUTH);
				assertThat(ex.getMessage()).contains("claude setup-token").doesNotContain(TOKEN);
			});
	}

	@Test
	void aUsageLimitIsReportedAsSuch() {
		String error = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,"
				+ "\"result\":\"Claude AI usage limit reached|1792700000\"}";
		assertThatThrownBy(() -> gateway(new FakeProcess(lines(error), "", 1), Duration.ofMinutes(1))
			.stream(question(), (t) -> {
			}))
			.isInstanceOfSatisfying(ClaudeException.class,
					(ex) -> assertThat(ex.kind()).isEqualTo(ClaudeException.Kind.RATE_LIMITED));
	}

	@Test
	void aCrashWithoutAResultReportsStderrScrubbed() {
		assertThatThrownBy(() -> gateway(new FakeProcess("", "fatal: something broke near " + TOKEN, 2),
				Duration.ofMinutes(1)).stream(question(), (t) -> {
				}))
			.isInstanceOfSatisfying(ClaudeException.class, (ex) -> {
				assertThat(ex.kind()).isEqualTo(ClaudeException.Kind.UNAVAILABLE);
				assertThat(ex.getMessage()).contains("something broke").contains("***").doesNotContain(TOKEN);
			});
	}

	@Test
	void aListenerThatThrowsKillsTheProcess() {
		FakeProcess fake = new FakeProcess(lines(INIT, delta("one"), delta("two"), RESULT), "", 0);
		List<String> seen = new ArrayList<>();
		assertThatThrownBy(() -> gateway(fake, Duration.ofMinutes(1)).stream(question(), (text) -> {
			seen.add(text);
			throw new IllegalStateException("gone");
		})).isInstanceOf(IllegalStateException.class);
		assertThat(seen).containsExactly("one");
	}

	@Test
	void aRunThatTakesTooLongIsKilled() throws Exception {
		FakeProcess fake = new FakeProcess();
		assertThatThrownBy(() -> gateway(fake, Duration.ofMillis(300)).stream(question(), (t) -> {
		})).isInstanceOfSatisfying(ClaudeException.class, (ex) -> assertThat(ex.getMessage()).contains("took longer"));
		assertThat(fake.killed).isTrue();
	}

	@Test
	void aMissingCliIsReportedBeforeAnythingStarts() {
		ClaudeCodeGateway missing = new ClaudeCodeGateway(this.dir.resolve("nope/claude").toString(), this.work,
				Duration.ofMinutes(1), (command, env, directory) -> {
					throw new AssertionError("must not start");
				});
		assertThat(missing.installed()).isFalse();
		assertThatThrownBy(() -> missing.stream(question(), (t) -> {
		})).isInstanceOfSatisfying(ClaudeException.class,
				(ex) -> assertThat(ex.getMessage()).contains("is not installed on the server"));
	}

}
