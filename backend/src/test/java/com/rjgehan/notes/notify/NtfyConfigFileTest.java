package com.rjgehan.notes.notify;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/** {@code ntfy.json} (ROADMAP items 9 and 38): the shape, the checks, and reading it again after a change. */
class NtfyConfigFileTest {

	private static final String TOPIC = "notes-6f1c9a0b";

	private static final String TOKEN = "tk_s3cr3tvalue";

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	@TempDir
	Path dir;

	private static NtfyConfigFile.Loaded parse(String json) {
		return NtfyConfigFile.parse(json.getBytes(StandardCharsets.UTF_8), MAPPER);
	}

	@Test
	void theTopicAloneIsEnoughAndNtfyShIsTheDefaultServer() {
		NtfyConfigFile.Loaded loaded = parse("{\"topic\": \"" + TOPIC + "\"}");
		assertThat(loaded.problem()).isNull();
		NtfyConfig config = loaded.config();
		assertThat(config).isNotNull();
		assertThat(config.server()).isEqualTo(URI.create("https://ntfy.sh"));
		assertThat(config.topic()).isEqualTo(TOPIC);
		assertThat(config.token()).isNull();
		assertThat(config.alerts().enabled()).isTrue();
		assertThat(config.alerts().topic()).isEqualTo(TOPIC);
	}

	@Test
	void everyMemberIsRead() {
		NtfyConfig config = parse("""
				{"server": "https://ntfy.example.com/", "topic": "%s", "token": "%s",
				 "alerts": {"enabled": true, "topic": "ops-alerts"}, "reminders": {"topic": "later"}}
				""".formatted(TOPIC, TOKEN)).config();
		assertThat(config).isNotNull();
		assertThat(config.server()).isEqualTo(URI.create("https://ntfy.example.com"));
		assertThat(config.token()).isEqualTo(TOKEN);
		assertThat(config.alerts().topic()).isEqualTo("ops-alerts");
	}

	@Test
	void alertsCanBeSwitchedOff() {
		assertThat(parse("{\"topic\": \"t\", \"alerts\": false}").config().alerts().enabled()).isFalse();
		assertThat(parse("{\"topic\": \"t\", \"alerts\": {\"enabled\": false}}").config().alerts().enabled())
			.isFalse();
	}

	@Test
	void problemsAreDescribedWithoutTheTopicOrTheToken() {
		String[] broken = { "not json", "[1, 2]", "{}", "{\"topic\": \"has space\"}",
				"{\"topic\": \"" + TOPIC + "\", \"server\": \"ftp://ntfy.sh\"}",
				"{\"topic\": \"" + TOPIC + "\", \"server\": \"https://user:" + TOKEN + "@ntfy.sh\"}",
				"{\"topic\": \"" + TOPIC + "\", \"server\": \"https://ntfy.sh/?x=1\"}",
				"{\"topic\": \"" + TOPIC + "\", \"server\": 42}",
				"{\"topic\": \"" + TOPIC + "\", \"token\": \"two words\"}",
				"{\"topic\": \"" + TOPIC + "\", \"token\": \"" + TOKEN + "\\r\\nX-Evil: 1\"}",
				"{\"topic\": \"" + TOPIC + "\", \"alerts\": \"yes\"}",
				"{\"topic\": \"" + TOPIC + "\", \"alerts\": {\"enabled\": \"yes\"}}",
				"{\"topic\": \"" + TOPIC + "\", \"alerts\": {\"topic\": \"bad topic!\"}}" };
		for (String json : broken) {
			NtfyConfigFile.Loaded loaded = parse(json);
			assertThat(loaded.config()).as(json).isNull();
			assertThat(loaded.problem()).as(json).startsWith("ntfy.json ").doesNotContain(TOPIC).doesNotContain(TOKEN);
		}
	}

	@Test
	void aTokenGoesOnlyOverHttpsOrToATailnetHost() {
		String token = ", \"token\": \"" + TOKEN + "\"}";
		assertThat(parse("{\"topic\": \"t\", \"server\": \"http://ntfy.example.com\"" + token).config()).isNull();
		assertThat(parse("{\"topic\": \"t\", \"server\": \"http://ntfy.example.com\"}").config()).isNotNull();
		for (String local : new String[] { "http://ntfy", "http://ntfy.tail1234.ts.net", "http://100.101.102.103:8080",
				"http://127.0.0.1", "http://localhost:2586", "http://[fd7a:115c:a1e0::1]" }) {
			assertThat(parse("{\"topic\": \"t\", \"server\": \"" + local + "\"" + token).config()).as(local)
				.isNotNull();
		}
		assertThat(NtfyConfigFile.isLocalHost("100.128.0.1")).isFalse();
		assertThat(NtfyConfigFile.isLocalHost("192.168.1.10")).isFalse();
	}

	@Test
	void aMissingFileIsNotConfiguredAndAChangedFileIsReadAgain() throws IOException {
		Path file = this.dir.resolve("ntfy.json");
		NtfyConfigFile reader = new NtfyConfigFile(file, MAPPER);
		assertThat(reader.load()).isEqualTo(new NtfyConfigFile.Loaded(null, null));

		Files.writeString(file, "{\"topic\": \"first\"}");
		assertThat(reader.load().config().topic()).isEqualTo("first");

		Files.writeString(file, "{\"topic\": \"second-topic\"}");
		Files.setLastModifiedTime(file, FileTime.from(Instant.now().plusSeconds(5)));
		assertThat(reader.load().config().topic()).isEqualTo("second-topic");

		Files.writeString(file, "{\"topic\": ");
		Files.setLastModifiedTime(file, FileTime.from(Instant.now().plusSeconds(10)));
		assertThat(reader.load().problem()).isEqualTo("ntfy.json is not valid JSON");

		Files.delete(file);
		assertThat(reader.load().config()).isNull();
		assertThat(reader.load().problem()).isNull();
	}

	@Test
	void aDirectoryOrAHugeFileIsAProblem() throws IOException {
		Path file = this.dir.resolve("ntfy.json");
		Files.createDirectory(file);
		assertThat(new NtfyConfigFile(file, MAPPER).load().problem()).isEqualTo("ntfy.json is not a file");
		Path big = this.dir.resolve("big.json");
		Files.write(big, new byte[70 * 1024]);
		assertThat(new NtfyConfigFile(big, MAPPER).load().problem()).isEqualTo("ntfy.json is larger than 64 KB");
	}

	@Test
	void toStringNeverShowsTheTopicOrTheToken() {
		NtfyConfig config = parse("{\"topic\": \"" + TOPIC + "\", \"token\": \"" + TOKEN + "\"}").config();
		assertThat(config.toString()).doesNotContain(TOPIC).doesNotContain(TOKEN).contains("ntfy.sh");
		assertThat(config.alerts().toString()).doesNotContain(TOPIC);
	}

}
