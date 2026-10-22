package com.rjgehan.notes.support;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * The properties every integration test runs with (DESIGN §8.1): its own vault, no watcher, short git periods, the
 * {@code localhost} Host allowlist, the default identity, and no Tailscale interface check.
 */
public final class IntegrationProperties {

	private IntegrationProperties() {
	}

	/** The common properties as a map, for applications started with {@code SpringApplicationBuilder}. */
	public static Map<String, String> common(Path vault) {
		Map<String, String> properties = new LinkedHashMap<>();
		properties.put("notes.vault-dir", vault.toString());
		properties.put("notes.watcher.enabled", "false");
		properties.put("notes.git.commit-quiet-period", "300ms");
		properties.put("notes.git.commit-max-delay", "2s");
		properties.put("notes.allowed-hosts", "localhost");
		properties.put("notes.identity.allow-default", "true");
		properties.put("notes.security.require-tailscale-interface", "false");
		// No ntfy.json and no backup status, whatever this machine has under /data (ROADMAP item 38).
		properties.put("notes.secrets-dir", "target/no-secrets");
		properties.put("notes.backup.status-file", "target/no-backup-state/status.json");
		// No extra vaults unless a test creates its own vaults folder (ROADMAP item 37).
		properties.put("notes.vaults.dir", "target/no-vaults");
		return properties;
	}

	/** Registers the common properties; the vault is read lazily, after JUnit has created it. */
	public static void register(DynamicPropertyRegistry registry, Supplier<Path> vault) {
		register(registry, vault, Map.of());
	}

	/** Registers the common properties with some of them replaced or added. */
	public static void register(DynamicPropertyRegistry registry, Supplier<Path> vault, Map<String, String> overrides) {
		Map<String, String> properties = common(Path.of("unused"));
		properties.putAll(overrides);
		properties.forEach((name, value) -> {
			if (name.equals("notes.vault-dir")) {
				registry.add(name, () -> vault.get().toString());
			}
			else {
				registry.add(name, () -> value);
			}
		});
	}

}
