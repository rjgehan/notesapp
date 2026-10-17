package com.rjgehan.notes.support;

import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import com.rjgehan.notes.NotesappApplication;
import com.rjgehan.notes.history.CommitBatcher;

import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.awaitility.Awaitility.await;

/**
 * The whole application started on a random port with the integration-test properties, for tests that need several
 * boots of the same vault (startup rules) or time a cold start (performance). Closing it shuts the server down.
 */
public final class RunningApp implements AutoCloseable {

	private final ConfigurableApplicationContext context;

	private final int port;

	private RunningApp(ConfigurableApplicationContext context) {
		this.context = context;
		this.port = ((WebServerApplicationContext) context).getWebServer().getPort();
	}

	public static RunningApp start(Path vault) {
		return start(vault, Map.of());
	}

	public static RunningApp start(Path vault, Map<String, String> overrides) {
		Map<String, String> properties = new LinkedHashMap<>(IntegrationProperties.common(vault));
		properties.put("server.port", "0");
		properties.put("spring.main.banner-mode", "off");
		properties.putAll(overrides);
		// Command-line arguments outrank application.properties; builder "properties" would only be defaults.
		String[] args = properties.entrySet()
			.stream()
			.map((entry) -> "--" + entry.getKey() + "=" + entry.getValue())
			.toArray(String[]::new);
		return new RunningApp(new SpringApplicationBuilder(NotesappApplication.class).run(args));
	}

	public int port() {
		return this.port;
	}

	public <T> T bean(Class<T> type) {
		return this.context.getBean(type);
	}

	/** A client for this server that sends the web client's headers. */
	public Api api() {
		return new Api(RestTestClient.bindToServer().baseUrl("http://localhost:" + this.port).build());
	}

	/** Waits until the startup git commit has run. */
	public RunningApp awaitGitBootstrap() {
		CommitBatcher batcher = bean(CommitBatcher.class);
		await().atMost(Duration.ofMinutes(3)).until(() -> !batcher.isImporting());
		return this;
	}

	@Override
	public void close() {
		this.context.close();
	}

}
