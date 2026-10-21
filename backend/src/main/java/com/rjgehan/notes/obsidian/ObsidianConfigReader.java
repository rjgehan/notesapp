package com.rjgehan.notes.obsidian;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.rjgehan.notes.vault.VaultFs;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Component;

/**
 * Reads the parts of {@code <vault>/.obsidian/} that NotesApp uses (ROADMAP item 24): {@code app.json},
 * {@code daily-notes.json}, {@code templates.json}, {@code graph.json}, {@code core-plugins.json} and
 * {@code community-plugins.json} with each enabled plugin's {@code manifest.json}. Read-only: the folder is never
 * written, so the vault stays usable in Obsidian. Symbolic links are not followed, and files over 1 MiB are skipped.
 */
@Component
public class ObsidianConfigReader {

	public static final String FOLDER = ".obsidian";

	static final long MAX_FILE_SIZE = 1024 * 1024;

	private static final int MAX_PLUGINS = 500;

	/** Obsidian plugin ids are folder names: letters, digits, dots, dashes and underscores. */
	private static final Pattern PLUGIN_ID = Pattern.compile("[A-Za-z0-9._-]{1,100}");

	private final VaultFs fs;

	private final JsonMapper mapper;

	public ObsidianConfigReader(VaultFs fs, JsonMapper mapper) {
		this.fs = fs;
		this.mapper = mapper;
	}

	public ObsidianConfig read() {
		return read(this.fs.root());
	}

	ObsidianConfig read(Path vault) {
		Path folder = vault.resolve(FOLDER);
		if (!Files.isDirectory(folder, LinkOption.NOFOLLOW_LINKS)) {
			return ObsidianConfig.NONE;
		}
		Reading reading = new Reading(folder);
		ObjectNode app = reading.object("app.json");
		ObjectNode daily = reading.object("daily-notes.json");
		ObjectNode templates = reading.object("templates.json");
		ObjectNode graph = reading.object("graph.json");
		Map<String, Boolean> core = new LinkedHashMap<>();
		JsonNode corePlugins = reading.json("core-plugins.json");
		if (corePlugins != null) {
			collectCore(corePlugins, core);
		}
		else {
			// Older Obsidian versions kept the switches here only.
			JsonNode migration = reading.json("core-plugins-migration.json");
			if (migration != null) {
				collectCore(migration, core);
			}
		}
		Map<String, String> community = new LinkedHashMap<>();
		JsonNode communityPlugins = reading.json("community-plugins.json");
		if (communityPlugins != null && communityPlugins.isArray()) {
			for (JsonNode item : communityPlugins.values()) {
				if (community.size() >= MAX_PLUGINS) {
					break;
				}
				if (item.isString() && PLUGIN_ID.matcher(item.stringValue()).matches()
						&& !item.stringValue().startsWith(".")) {
					String id = item.stringValue();
					community.put(id, reading.pluginName(id));
				}
			}
		}
		return new ObsidianConfig(true, app, daily, templates, graph, core, community, reading.files,
				reading.problems);
	}

	private static void collectCore(JsonNode node, Map<String, Boolean> core) {
		if (node.isArray()) {
			for (JsonNode item : node.values()) {
				if (item.isString()) {
					core.put(item.stringValue(), true);
				}
			}
		}
		else if (node.isObject()) {
			node.properties().forEach((entry) -> {
				if (entry.getValue().isBoolean()) {
					core.put(entry.getKey(), entry.getValue().booleanValue());
				}
			});
		}
	}

	private final class Reading {

		final Path folder;

		final List<String> files = new ArrayList<>();

		final List<String> problems = new ArrayList<>();

		Reading(Path folder) {
			this.folder = folder;
		}

		@Nullable ObjectNode object(String name) {
			JsonNode node = json(name);
			if (node == null) {
				return null;
			}
			if (node instanceof ObjectNode object) {
				return object;
			}
			this.problems.add(name + " is not a JSON object");
			return null;
		}

		@Nullable JsonNode json(String name) {
			String text = text(this.folder.resolve(name), name, true);
			if (text == null) {
				return null;
			}
			try {
				JsonNode node = ObsidianConfigReader.this.mapper.readTree(text);
				this.files.add(name);
				return node;
			}
			catch (JacksonException ex) {
				this.problems.add(name + " is not valid JSON");
				return null;
			}
		}

		String pluginName(String id) {
			Path manifest = this.folder.resolve("plugins").resolve(id).resolve("manifest.json");
			if (!manifest.normalize().startsWith(this.folder)) {
				return id;
			}
			String text = text(manifest, "plugins/" + id + "/manifest.json", false);
			if (text != null) {
				try {
					JsonNode name = ObsidianConfigReader.this.mapper.readTree(text).get("name");
					if (name != null && name.isString() && !name.stringValue().isBlank()) {
						return name.stringValue().strip();
					}
				}
				catch (JacksonException ex) {
					// The id stands in for a missing or broken manifest.
				}
			}
			return ObsidianPlugins.knownName(id);
		}

		/** The file's text, or null when it is absent, not a regular file, too large or unreadable. */
		private @Nullable String text(Path file, String name, boolean report) {
			try {
				BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class,
						LinkOption.NOFOLLOW_LINKS);
				if (!attributes.isRegularFile()) {
					if (report) {
						this.problems.add(name + " is not a regular file");
					}
					return null;
				}
				if (attributes.size() > MAX_FILE_SIZE) {
					if (report) {
						this.problems.add(name + " is larger than 1 MB");
					}
					return null;
				}
				String text = Files.readString(file, StandardCharsets.UTF_8);
				return text.startsWith("﻿") ? text.substring(1) : text;
			}
			catch (java.nio.file.NoSuchFileException ex) {
				return null;
			}
			catch (IOException | RuntimeException ex) {
				if (report) {
					this.problems.add(name + " could not be read");
				}
				return null;
			}
		}

	}

}
