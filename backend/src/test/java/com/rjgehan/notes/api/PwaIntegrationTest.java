package com.rjgehan.notes.api;

import java.nio.file.Path;
import java.time.Duration;

import com.rjgehan.notes.history.CommitBatcher;
import com.rjgehan.notes.support.Api;
import com.rjgehan.notes.support.Api.Reply;
import com.rjgehan.notes.support.IntegrationProperties;
import com.rjgehan.notes.support.NotesIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.client.RestTestClient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The installable app (DESIGN §6.26): the service worker and the manifest are served with the headers a deploy's
 * update check relies on, and API responses stay {@code no-store}. The test classpath carries stand-ins for
 * {@code static/sw.js} and {@code static/manifest.webmanifest}.
 */
@NotesIntegrationTest
class PwaIntegrationTest {

	@TempDir
	static Path vault;

	@DynamicPropertySource
	static void properties(DynamicPropertyRegistry registry) {
		IntegrationProperties.register(registry, () -> vault);
	}

	@Autowired
	RestTestClient client;

	@Autowired
	CommitBatcher batcher;

	private Api api;

	@BeforeEach
	void setUp() {
		this.api = new Api(this.client);
		await().atMost(Duration.ofSeconds(30)).until(() -> !this.batcher.isImporting());
	}

	@Test
	void theServiceWorkerIsAlwaysRevalidatedAndMayControlTheOrigin() {
		Reply sw = this.api.get("/sw.js", "X-Client-Id", null);
		assertThat(sw.status()).isEqualTo(200);
		assertThat(sw.text()).contains("NotesApp test service worker");
		assertThat(sw.header("Content-Type")).startsWith("text/javascript");
		assertThat(sw.headers().get("Cache-Control")).containsExactly("no-cache");
		assertThat(sw.header("Service-Worker-Allowed")).isEqualTo("/");
		assertThat(sw.header("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(sw.header("Content-Security-Policy")).contains("worker-src 'self' blob:").contains("connect-src 'self'");
		assertThat(sw.header("X-Notes-Build")).isEqualTo("dev");
	}

	@Test
	void theManifestHasItsMediaTypeAndIsRevalidated() {
		Reply manifest = this.api.get("/manifest.webmanifest", "X-Client-Id", null);
		assertThat(manifest.status()).isEqualTo(200);
		assertThat(manifest.header("Content-Type")).startsWith("application/manifest+json");
		assertThat(manifest.headers().get("Cache-Control")).containsExactly("no-cache");
		assertThat(manifest.json().get("display").asString()).isEqualTo("standalone");
		assertThat(manifest.header("Content-Security-Policy")).contains("manifest-src 'self'");
		assertThat(manifest.header("Service-Worker-Allowed")).isNull();
	}

	@Test
	void apiResponsesStayUncacheable() {
		Reply tree = this.api.get("/api/tree");
		assertThat(tree.status()).isEqualTo(200);
		assertThat(tree.headers().get("Cache-Control")).containsExactly("no-store");
		assertThat(tree.header("Service-Worker-Allowed")).isNull();
	}

}
