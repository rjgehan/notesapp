package com.rjgehan.notes.support;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import com.rjgehan.notes.config.NotesProperties;

import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/** Binds {@link NotesProperties} with its defaults, the way Spring Boot does, for unit tests. */
public final class TestProperties {

	private TestProperties() {
	}

	public static NotesProperties forVault(Path vault) {
		return forVault(vault, Map.of());
	}

	public static NotesProperties forVault(Path vault, Map<String, String> overrides) {
		Map<String, String> source = new HashMap<>();
		source.put("notes.vault-dir", vault.toString());
		source.putAll(overrides);
		return new Binder(new MapConfigurationPropertySource(source)).bind("notes", NotesProperties.class)
			.orElseThrow(() -> new IllegalStateException("cannot bind notes properties"));
	}

}
