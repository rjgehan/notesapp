package com.rjgehan.notes.config;

import java.time.Instant;
import java.util.Map;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

class JsonConfigTest {

	private final JsonMapper mapper = mapper();

	private static JsonMapper mapper() {
		JsonMapper.Builder builder = JsonMapper.builder();
		new JsonConfig().notesJsonMapperCustomizer().customize(builder);
		return builder.build();
	}

	@Test
	void instantsAreTruncatedToExactlyThreeFractionalDigits() {
		assertThat(this.mapper.writeValueAsString(Instant.parse("2026-10-16T14:03:22.120345678Z")))
			.isEqualTo("\"2026-10-16T14:03:22.120Z\"");
	}

	@Test
	void wholeSecondsGetThreeZeroDigits() {
		assertThat(this.mapper.writeValueAsString(Instant.parse("2026-10-16T14:03:02Z")))
			.isEqualTo("\"2026-10-16T14:03:02.000Z\"");
	}

	@Test
	void instantsInsideObjectsUseTheSameFormat() {
		assertThat(this.mapper.writeValueAsString(Map.of("t", Instant.parse("2026-01-02T03:04:05.6Z"))))
			.isEqualTo("{\"t\":\"2026-01-02T03:04:05.600Z\"}");
	}

	@Test
	void emptyRecordsSerializeAsEmptyObjects() {
		record Empty() {
		}
		assertThat(this.mapper.writeValueAsString(new Empty())).isEqualTo("{}");
	}

}
