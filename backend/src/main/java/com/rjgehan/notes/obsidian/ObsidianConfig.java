package com.rjgehan.notes.obsidian;

import java.util.List;
import java.util.Map;

import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ObjectNode;

/**
 * What a vault's {@code .obsidian/} folder says, as far as NotesApp uses it. Each JSON file is null when it is absent
 * or unreadable ({@code problems} then says why). {@code corePlugins} maps every core plugin the vault lists to
 * whether it is on; {@code communityPlugins} lists the enabled community plugins with their display names.
 */
public record ObsidianConfig(boolean found, @Nullable ObjectNode app, @Nullable ObjectNode dailyNotes,
		@Nullable ObjectNode templates, @Nullable ObjectNode graph, Map<String, Boolean> corePlugins,
		Map<String, String> communityPlugins, List<String> files, List<String> problems) {

	/** A vault without {@code .obsidian/}. */
	public static final ObsidianConfig NONE = new ObsidianConfig(false, null, null, null, null, Map.of(), Map.of(),
			List.of(), List.of());

}
