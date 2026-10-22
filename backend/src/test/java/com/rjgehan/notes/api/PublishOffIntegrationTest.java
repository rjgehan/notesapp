package com.rjgehan.notes.api;

import java.io.IOException;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Path;
import java.util.Map;

import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.publish.PublishServer;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Publishing as shipped (ROADMAP item 26 decision): off, with no listener and nothing publishable. */
@NotesIntegrationTest
class PublishOffIntegrationTest {

	@TempDir
	static Path vault;

	static final int PORT = freePort();

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		// Only the port is set, so the listener would be found if it started; enabled keeps its default.
		IntegrationProperties.register(registry, () -> vault, Map.of("notes.publish.port", Integer.toString(PORT)));
	}

	@Autowired
	RestTestClient client;

	@Autowired
	PublishServer server;

	@Autowired
	NotesProperties properties;

	@Test
	void publishingIsOffByDefaultAndNothingListens() throws Exception {
		assertThat(this.properties.publish().enabled()).isFalse();
		assertThat(this.server.isRunning()).isFalse();
		assertThat(this.server.port()).isEqualTo(-1);
		assertThatThrownBy(() -> {
			try (Socket socket = new Socket()) {
				socket.connect(new InetSocketAddress("127.0.0.1", PORT), 2000);
			}
		}).isInstanceOf(ConnectException.class);

		Api api = new Api(this.client);
		api.postJson("/api/files", Map.of("path", "Note.md", "content", "x\n")).ok(201);
		JsonNode list = api.get("/api/publish").ok(200);
		assertThat(list.get("enabled").asBoolean()).isFalse();
		assertThat(list.get("notes").size()).isZero();
		assertThat(api.postJson("/api/publish", Map.of("path", "Note.md")).problem(409)).isEqualTo("publishing-off");
	}

	private static int freePort() {
		try (ServerSocket socket = new ServerSocket(0)) {
			return socket.getLocalPort();
		}
		catch (IOException ex) {
			throw new IllegalStateException(ex);
		}
	}

}
