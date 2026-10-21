package com.rjgehan.notes.config;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;

import tools.jackson.core.JsonGenerator;
import tools.jackson.core.util.DefaultIndenter;
import tools.jackson.core.util.DefaultPrettyPrinter;
import tools.jackson.core.util.Separators;
import tools.jackson.databind.ObjectWriter;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.module.SimpleModule;
import tools.jackson.databind.ser.std.StdSerializer;

import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Serializes every {@link Instant} with exactly three fractional digits (API.md §1.5). Jackson's default
 * {@code ISO_INSTANT} emits 0, 3, 6 or 9 digits depending on the value.
 */
@Configuration(proxyBeanMethods = false)
public class JsonConfig {

	private static final DateTimeFormatter INSTANT_FORMAT = DateTimeFormatter
		.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
		.withZone(ZoneOffset.UTC);

	/** Formats an instant the way the API transmits it, truncated to milliseconds. */
	public static String formatInstant(Instant instant) {
		return INSTANT_FORMAT.format(instant.truncatedTo(ChronoUnit.MILLIS));
	}

	@Bean
	JsonMapperBuilderCustomizer notesJsonMapperCustomizer() {
		return builder -> builder.addModule(notesModule())
			// TrashChangedEvent is an empty record that must serialize as {}.
			.disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);
	}

	/** The module that formats instants; also used where a mapper is built outside Spring. */
	public static SimpleModule notesModule() {
		return new SimpleModule("notes-instants").addSerializer(Instant.class, new MillisInstantSerializer());
	}

	/**
	 * The writer for JSON files the app keeps in the vault ({@code .notesapp/settings.json}, {@code .tasks} lists):
	 * two-space indentation, {@code "key": value} and {@code []} for empty arrays, so files read and diff like
	 * {@code JSON.stringify(value, null, 2)}.
	 */
	public static ObjectWriter vaultFileWriter(JsonMapper mapper) {
		DefaultIndenter indenter = new DefaultIndenter("  ", "\n");
		DefaultPrettyPrinter printer = new DefaultPrettyPrinter(Separators.createDefaultInstance()
			.withObjectNameValueSpacing(Separators.Spacing.AFTER)
			.withObjectEmptySeparator("")
			.withArrayEmptySeparator("")).withObjectIndenter(indenter).withArrayIndenter(indenter);
		return mapper.writer().with(printer);
	}

	static final class MillisInstantSerializer extends StdSerializer<Instant> {

		MillisInstantSerializer() {
			super(Instant.class);
		}

		@Override
		public void serialize(Instant value, JsonGenerator gen, SerializationContext ctxt) {
			gen.writeString(formatInstant(value));
		}

	}

}
