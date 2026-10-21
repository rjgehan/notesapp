package com.rjgehan.notes.ai;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * {@link ClaudeGateway} through the Claude Code CLI with the user's Claude subscription (the default provider, DESIGN
 * §5.20): one headless run per answer, {@code claude -p} with the prompt on stdin and
 * {@code --output-format stream-json --verbose --include-partial-messages}, read line by line.
 *
 * <p>The run is locked down: every tool is disabled ({@code --tools ""}), so Claude answers only from the notes the app
 * put in the prompt and can never read the vault (excluded folders stay out); the system prompt replaces Claude Code's
 * own; no session is kept, no MCP server, setting, hook or {@code CLAUDE.md} is loaded, because the process gets a
 * fresh, empty home and working directory, deleted afterwards, and a clean environment holding only the OAuth token
 * ({@code CLAUDE_CODE_OAUTH_TOKEN}, from {@code claude setup-token}). The token is never put on the command line or
 * logged, and error texts are scrubbed of anything token-shaped.
 *
 * <p>When the listener throws (the browser went away) or the time is up, the process tree is killed.
 */
public class ClaudeCodeGateway implements ClaudeGateway {

	private static final Logger logger = LoggerFactory.getLogger(ClaudeCodeGateway.class);

	private static final Pattern SECRET = Pattern.compile("sk-ant-[A-Za-z0-9_-]+");

	private static final int MAX_MESSAGE = 300;

	private static final int MAX_STDERR = 4096;

	/** Starts a process; the tests replace it with a fake one. */
	@FunctionalInterface
	public interface Launcher {

		Process start(List<String> command, Map<String, String> environment, Path directory) throws IOException;

		Launcher DEFAULT = (command, environment, directory) -> {
			ProcessBuilder builder = new ProcessBuilder(command).directory(directory.toFile());
			builder.environment().clear();
			builder.environment().putAll(environment);
			return builder.start();
		};

	}

	private final String command;

	private final Path workRoot;

	private final Duration timeout;

	private final Launcher launcher;

	private final JsonMapper mapper = JsonMapper.builder().build();

	public ClaudeCodeGateway(String command, Path workRoot, Duration timeout, Launcher launcher) {
		this.command = command;
		this.workRoot = workRoot;
		this.timeout = timeout;
		this.launcher = launcher;
	}

	/** True when the CLI can be found: an executable path, or a name on the {@code PATH}. */
	public boolean installed() {
		return resolve() != null;
	}

	public String command() {
		return this.command;
	}

	private @Nullable Path resolve() {
		if (this.command.contains("/") || this.command.contains(File.separator)) {
			Path path = Path.of(this.command);
			return Files.isExecutable(path) ? path : null;
		}
		String pathVariable = System.getenv("PATH");
		if (pathVariable == null) {
			return null;
		}
		for (String dir : pathVariable.split(File.pathSeparator)) {
			if (dir.isBlank()) {
				continue;
			}
			for (String name : List.of(this.command, this.command + ".exe", this.command + ".cmd")) {
				Path candidate = Path.of(dir, name);
				if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
					return candidate;
				}
			}
		}
		return null;
	}

	/** The command line of a run; the prompt goes to stdin, the token to the environment. */
	List<String> commandLine(String executable, Request request) {
		return List.of(executable, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
				"--model", request.model(), "--system-prompt", request.system(), "--tools", "",
				"--permission-mode", "dontAsk", "--strict-mcp-config", "--no-session-persistence",
				"--disable-slash-commands");
	}

	/** The whole environment of a run: nothing is inherited from the server's. */
	static Map<String, String> environment(String token, Path home, @Nullable Path executable) {
		Map<String, String> env = new LinkedHashMap<>();
		String binDir = (executable != null && executable.getParent() != null) ? executable.getParent().toString() : null;
		env.put("PATH", ((binDir != null) ? binDir + File.pathSeparator : "") + "/usr/local/bin:/usr/bin:/bin");
		env.put("HOME", home.toString());
		env.put("USERPROFILE", home.toString());
		env.put("CLAUDE_CONFIG_DIR", home.resolve(".claude").toString());
		env.put("TMPDIR", home.resolve("tmp").toString());
		env.put("LANG", "C.UTF-8");
		String tz = System.getenv("TZ");
		if (tz != null) {
			env.put("TZ", tz);
		}
		env.put("CLAUDE_CODE_OAUTH_TOKEN", token);
		env.put("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
		env.put("DISABLE_AUTOUPDATER", "1");
		env.put("CI", "1");
		return env;
	}

	/**
	 * The prompt on stdin. The CLI takes one user message, so earlier turns become a transcript before the new
	 * message; the system prompt already says how notes and citations work.
	 */
	static String prompt(Request request) {
		List<Message> messages = request.messages();
		if (messages.size() == 1) {
			return text(messages.get(0));
		}
		StringBuilder out = new StringBuilder("<earlier_turns>\n");
		for (int i = 0; i < messages.size() - 1; i++) {
			Message message = messages.get(i);
			String role = (message.role() == Role.USER) ? "user" : "assistant";
			out.append('<').append(role).append(">\n").append(text(message).replace("</" + role, "</ " + role))
				.append("\n</").append(role).append(">\n");
		}
		out.append("</earlier_turns>\n\nThe earlier turns of this conversation are above. Answer this new message:\n\n")
			.append(text(messages.get(messages.size() - 1)));
		return out.toString();
	}

	private static String text(Message message) {
		return message.blocks().stream().map(Block::text).reduce("", String::concat);
	}

	@Override
	public Result stream(Request request, Listener listener) throws ClaudeException {
		Path executable = resolve();
		if (executable == null) {
			throw new ClaudeException(ClaudeException.Kind.UNAVAILABLE,
					"The Claude Code CLI (" + this.command + ") is not installed on the server");
		}
		Path home;
		try {
			Files.createDirectories(this.workRoot);
			home = Files.createTempDirectory(this.workRoot, "run-");
			Files.createDirectories(home.resolve("tmp"));
			Files.createDirectories(home.resolve(".claude"));
		}
		catch (IOException ex) {
			throw new ClaudeException(ClaudeException.Kind.UNAVAILABLE,
					"No working directory for Claude Code (" + ex.getClass().getSimpleName() + ")");
		}
		Process process = null;
		AtomicBoolean timedOut = new AtomicBoolean();
		try {
			try {
				process = this.launcher.start(commandLine(executable.toString(), request),
						environment(request.credential(), home, executable), home);
			}
			catch (IOException ex) {
				throw new ClaudeException(ClaudeException.Kind.UNAVAILABLE,
						"Claude Code could not be started (" + ex.getClass().getSimpleName() + ")");
			}
			Process running = process;
			String input = prompt(request);
			Thread.ofVirtual().name("claude-stdin").start(() -> {
				try (OutputStream stdin = running.getOutputStream()) {
					stdin.write(input.getBytes(StandardCharsets.UTF_8));
				}
				catch (IOException ex) {
					// The process ended early; its output says why.
				}
			});
			StringBuilder stderr = new StringBuilder();
			Thread errors = Thread.ofVirtual().name("claude-stderr").start(() -> drain(running.getErrorStream(), stderr));
			Thread watchdog = Thread.ofVirtual().name("claude-timeout").start(() -> {
				try {
					if (!running.waitFor(this.timeout.toMillis(), TimeUnit.MILLISECONDS)) {
						timedOut.set(true);
						kill(running);
					}
				}
				catch (InterruptedException ex) {
					Thread.currentThread().interrupt();
				}
			});
			Run run = new Run(request.model());
			try (BufferedReader out = new BufferedReader(
					new InputStreamReader(running.getInputStream(), StandardCharsets.UTF_8))) {
				String line;
				while ((line = out.readLine()) != null) {
					run.line(line, listener);
				}
			}
			catch (IOException ex) {
				// The stream ended with the process; handled below.
			}
			int exit = waitFor(running);
			watchdog.interrupt();
			joinQuietly(errors);
			if (timedOut.get()) {
				throw new ClaudeException(ClaudeException.Kind.UNAVAILABLE,
						"Claude Code took longer than " + this.timeout.toMinutes() + " minutes and was stopped");
			}
			return run.result(exit, stderrTail(stderr));
		}
		finally {
			if (process != null && process.isAlive()) {
				kill(process);
			}
			deleteQuietly(home);
		}
	}

	/** The state of one run, built from the JSON lines. */
	private final class Run {

		private String model;

		private boolean streamedText;

		private final StringBuilder fallbackText = new StringBuilder();

		private @Nullable JsonNode result;

		Run(String model) {
			this.model = model;
		}

		void line(String line, Listener listener) {
			if (line.isBlank()) {
				return;
			}
			JsonNode node;
			try {
				node = ClaudeCodeGateway.this.mapper.readTree(line);
			}
			catch (JacksonException ex) {
				return;
			}
			String type = node.path("type").asString("");
			switch (type) {
				case "system" -> {
					String model = node.path("model").asString("");
					if (!model.isEmpty()) {
						this.model = model;
					}
				}
				case "stream_event" -> {
					if (!node.path("parent_tool_use_id").isNull() && node.has("parent_tool_use_id")) {
						return;
					}
					JsonNode event = node.path("event");
					String eventType = event.path("type").asString("");
					if (eventType.equals("message_start")) {
						String model = event.path("message").path("model").asString("");
						if (!model.isEmpty()) {
							this.model = model;
						}
					}
					else if (eventType.equals("content_block_delta")
							&& event.path("delta").path("type").asString("").equals("text_delta")) {
						String text = event.path("delta").path("text").asString("");
						if (!text.isEmpty()) {
							this.streamedText = true;
							listener.onText(text);
						}
					}
				}
				case "assistant" -> {
					// Without partial messages (an older CLI), the whole message arrives here.
					for (JsonNode block : node.path("message").path("content")) {
						if (block.path("type").asString("").equals("text")) {
							this.fallbackText.append(block.path("text").asString(""));
						}
					}
				}
				case "result" -> this.result = node;
				default -> {
				}
			}
			if (type.equals("result") && !this.streamedText && this.fallbackText.length() > 0
					&& !node.path("is_error").asBoolean(false)) {
				listener.onText(this.fallbackText.toString());
				this.streamedText = true;
			}
		}

		Result result(int exit, String stderr) throws ClaudeException {
			JsonNode node = this.result;
			if (node == null) {
				String detail = stderr.isBlank() ? "exit code " + exit : stderr;
				throw failure(detail);
			}
			if (node.path("is_error").asBoolean(false) || !node.path("subtype").asString("success").equals("success")) {
				String text = node.path("result").asString("");
				throw failure(text.isBlank() ? node.path("subtype").asString("error") : text);
			}
			JsonNode usage = node.path("usage");
			AiModels.Usage counted = new AiModels.Usage(usage.path("input_tokens").asLong(0),
					usage.path("output_tokens").asLong(0), usage.path("cache_read_input_tokens").asLong(0),
					usage.path("cache_creation_input_tokens").asLong(0));
			JsonNode models = node.path("modelUsage");
			if (models.isObject() && models.size() == 1) {
				this.model = models.propertyNames().iterator().next();
			}
			Double cost = node.has("total_cost_usd") ? node.path("total_cost_usd").asDouble(0) : null;
			String stop = node.path("stop_reason").asString("");
			return new Result(this.model, stop.isEmpty() ? "end_turn" : stop, null, List.of(new Hop(this.model, counted)),
					false, cost);
		}

	}

	/** Maps a failure text from the CLI to a kind and a short, scrubbed message. */
	static ClaudeException failure(String raw) {
		String text = SECRET.matcher(raw.strip()).replaceAll("***");
		if (text.length() > MAX_MESSAGE) {
			text = text.substring(0, MAX_MESSAGE) + "…";
		}
		String lower = text.toLowerCase(Locale.ROOT);
		ClaudeException.Kind kind;
		String prefix;
		if (lower.contains("usage limit") || lower.contains("rate limit") || lower.contains("rate_limit")
				|| lower.contains("limit reached")) {
			kind = ClaudeException.Kind.RATE_LIMITED;
			prefix = "Your Claude plan's usage limit is reached for now: ";
		}
		else if (lower.contains("login") || lower.contains("oauth") || lower.contains("token")
				|| lower.contains("authenticat") || lower.contains("401") || lower.contains("api key")) {
			kind = ClaudeException.Kind.AUTH;
			prefix = "Claude Code refused the token (make a new one with claude setup-token): ";
		}
		else if (lower.contains("overloaded") || lower.contains("529")) {
			kind = ClaudeException.Kind.OVERLOADED;
			prefix = "Claude is overloaded; try again in a minute: ";
		}
		else {
			kind = ClaudeException.Kind.UNAVAILABLE;
			prefix = "Claude Code failed: ";
		}
		return new ClaudeException(kind, prefix + text);
	}

	private static void drain(InputStream in, StringBuilder sink) {
		byte[] buffer = new byte[4096];
		try (in) {
			int n;
			while ((n = in.read(buffer)) >= 0) {
				synchronized (sink) {
					sink.append(new String(buffer, 0, n, StandardCharsets.UTF_8));
					if (sink.length() > MAX_STDERR * 2) {
						sink.delete(0, sink.length() - MAX_STDERR);
					}
				}
			}
		}
		catch (IOException ex) {
			// The process ended.
		}
	}

	private static String stderrTail(StringBuilder stderr) {
		synchronized (stderr) {
			String text = stderr.toString().strip();
			return (text.length() > MAX_STDERR) ? text.substring(text.length() - MAX_STDERR) : text;
		}
	}

	private static int waitFor(Process process) {
		try {
			if (process.waitFor(10, TimeUnit.SECONDS)) {
				return process.exitValue();
			}
			kill(process);
			return -1;
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			kill(process);
			return -1;
		}
	}

	/** Ends the process and everything it started. */
	static void kill(Process process) {
		try {
			process.descendants().forEach(ProcessHandle::destroyForcibly);
		}
		catch (UnsupportedOperationException ex) {
			// A fake process in the tests.
		}
		process.destroyForcibly();
	}

	private static void joinQuietly(Thread thread) {
		try {
			thread.join(Duration.ofSeconds(2));
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
		}
	}

	private static void deleteQuietly(Path dir) {
		try (Stream<Path> walk = Files.walk(dir)) {
			for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
				Files.deleteIfExists(path);
			}
		}
		catch (IOException ex) {
			logger.debug("Could not delete the Claude Code run directory {}: {}", dir, ex.toString());
		}
	}

	@Override
	public String toString() {
		return "ClaudeCodeGateway[" + this.command + "]";
	}


}
