package com.rjgehan.notes.api.dto;

import java.time.Instant;
import java.util.List;

import com.rjgehan.notes.settings.Settings;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.node.ObjectNode;

/**
 * {@code GET /api/compat} (API.md §11.5, ROADMAP item 24): how well this vault, typically an imported Obsidian vault,
 * works in NotesApp. {@code proposedSettings} are the current settings with what {@code .obsidian/} says applied, to be
 * saved with {@code PUT /api/settings} and {@code baseVersion: settingsVersion}; {@code graph} holds the graph view
 * options of {@code .obsidian/graph.json} that the client understands.
 */
public record CompatReport(Instant generatedAt, long tookMs, ObsidianInfo obsidian, List<CompatSetting> settings,
		@Nullable Settings proposedSettings, String settingsVersion, @Nullable ObjectNode graph,
		List<CompatPlugin> plugins, List<CompatIssue> issues, CompatTotals totals) {

	public CompatReport {
		settings = List.copyOf(settings);
		plugins = List.copyOf(plugins);
		issues = List.copyOf(issues);
	}

}
