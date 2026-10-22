package com.rjgehan.notes.publish;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import com.rjgehan.notes.support.TestProperties;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The ROADMAP item 26 decision, "built switched off; nothing is exposed until you enable it", as shipped: the
 * configuration default, both compose files and the Tailscale serve config all keep public publishing off, and the
 * opt-in Funnel config opens the publish server's port alone.
 */
class PublishDeployDefaultsTest {

	private static final Path DEPLOY = Path.of("..", "deploy");

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Test
	void theApplicationDefaultIsOff() throws Exception {
		assertThat(TestProperties.forVault(Path.of("vault"), Map.of()).publish().enabled()).isFalse();
		assertThat(TestProperties.forVault(Path.of("vault"), Map.of()).publish().address()).isEqualTo("127.0.0.1");
		String properties = Files.readString(Path.of("src/main/resources/application.properties"));
		assertThat(properties).doesNotContain("notes.publish.enabled");
	}

	@Test
	void theComposeFilesShipItOff() throws Exception {
		String compose = Files.readString(DEPLOY.resolve("docker-compose.yml"));
		assertThat(compose).contains("NOTES_PUBLISH_ENABLED: ${NOTES_PUBLISH_ENABLED:-false}");
		assertThat(Files.readString(DEPLOY.resolve(".env.example"))).contains("\nNOTES_PUBLISH_ENABLED=false\n");

		String casaos = Files.readString(DEPLOY.resolve("casaos-compose.yml")).replace("\r\n", "\n");
		assertThat(casaos).contains("      NOTES_PUBLISH_ENABLED: \"false\"\n")
			.contains("      NOTES_PUBLISH_FUNNEL: \"false\"\n")
			// $$ so that Compose leaves the variable to the shell instead of replacing it with the host's (empty) one.
			.contains("if [ \"$$NOTES_PUBLISH_FUNNEL\" = \"true\" ]; then");
		// The serve.json written when the switch is off has no Funnel and no second port.
		String off = casaos.substring(casaos.indexOf("        else\n"), casaos.indexOf("        fi\n"));
		assertThat(off).contains("\"AllowFunnel\": { \"notes.CHANGE-ME.ts.net:443\": false }")
			.doesNotContain("8443")
			.doesNotContain("8081");
	}

	@Test
	void theShippedServeConfigHasNoFunnelAndTheOptInOpensOnlyThePublishServer() throws Exception {
		JsonNode shipped = JSON.readTree(Files.readString(DEPLOY.resolve("tailscale/serve.json")));
		assertThat(shipped.get("TCP").propertyNames()).containsExactly("443");
		shipped.get("AllowFunnel").forEach((allowed) -> assertThat(allowed.asBoolean()).isFalse());
		assertThat(shipped.toString()).doesNotContain("8081");

		JsonNode funnel = JSON.readTree(Files.readString(DEPLOY.resolve("tailscale/serve.funnel.json.example")));
		JsonNode allow = funnel.get("AllowFunnel");
		assertThat(allow.get("${TS_CERT_DOMAIN}:443").asBoolean()).isFalse();
		assertThat(allow.get("${TS_CERT_DOMAIN}:8443").asBoolean()).isTrue();
		assertThat(allow.size()).isEqualTo(2);
		JsonNode web = funnel.get("Web");
		assertThat(web.get("${TS_CERT_DOMAIN}:443").toString()).contains("http://127.0.0.1:8080");
		assertThat(web.get("${TS_CERT_DOMAIN}:8443").toString()).contains("http://127.0.0.1:8081")
			.doesNotContain("8080");
	}

}
