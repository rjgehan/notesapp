package com.rjgehan.notes.obsidian;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.api.dto.CompatIssue;
import com.rjgehan.notes.api.dto.CompatPlugin;
import com.rjgehan.notes.api.dto.CompatReport;
import com.rjgehan.notes.api.dto.CompatSetting;
import com.rjgehan.notes.api.dto.CompatTotals;
import com.rjgehan.notes.api.dto.ObsidianInfo;
import com.rjgehan.notes.api.dto.SettingsResponse;
import com.rjgehan.notes.index.VaultIndex;
import com.rjgehan.notes.settings.Settings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.FileKinds;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.stereotype.Service;

/**
 * {@code GET /api/compat} (API.md §11.5, ROADMAP item 24): the Obsidian compatibility report. Computed on request
 * from {@code .obsidian/}, the settings and a snapshot of the index; nothing is stored or written.
 */
@Service
public class CompatService {

	/** The keys of {@code graph.json} the graph view understands (DESIGN §6.28). */
	static final Set<String> GRAPH_KEYS = Set.of("search", "showTags", "showAttachments", "hideUnresolved",
			"showOrphans", "colorGroups", "showArrow", "textFadeMultiplier", "nodeSizeMultiplier", "lineSizeMultiplier",
			"centerStrength", "repelStrength", "linkStrength", "linkDistance");

	private final VaultIndex index;

	private final ObsidianConfigReader reader;

	private final SettingsService settings;

	private final FileKinds kinds;

	private final Clock clock;

	public CompatService(VaultIndex index, ObsidianConfigReader reader, SettingsService settings, FileKinds kinds,
			Clock clock) {
		this.index = index;
		this.reader = reader;
		this.settings = settings;
		this.kinds = kinds;
		this.clock = clock;
	}

	public CompatReport report() {
		long started = System.nanoTime();
		ObsidianConfig config = this.reader.read();
		SettingsResponse current = this.settings.get();
		List<CompatSetting> rows = List.of();
		Settings proposed = null;
		if (config.found()) {
			ObsidianSettings.Mapping mapping = ObsidianSettings.map(config, current.settings());
			rows = mapping.rows();
			proposed = mapping.proposed();
		}
		List<CompatIssue> issues = CompatScanner.scan(this.index.noteViews(), this.index.filesUnder(""),
				this.index.skipped(), this.kinds::kindOf);
		int errors = 0;
		int warnings = 0;
		int infos = 0;
		for (CompatIssue issue : issues) {
			switch (issue.severity()) {
				case ERROR -> errors += issue.count();
				case WARNING -> warnings += issue.count();
				case INFO -> infos += issue.count();
			}
		}
		VaultIndex.Stats stats = this.index.stats();
		return new CompatReport(this.clock.instant(),
				TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started),
				new ObsidianInfo(config.found(), config.files(), config.problems()), rows, proposed, current.version(),
				graph(config.graph()), plugins(config), issues,
				new CompatTotals(stats.notes(), stats.files(), errors, warnings, infos));
	}

	/** The enabled plugins: core ones first, each group by support (most problematic first), then name. */
	static List<CompatPlugin> plugins(ObsidianConfig config) {
		List<CompatPlugin> core = new ArrayList<>();
		for (Map.Entry<String, Boolean> entry : config.corePlugins().entrySet()) {
			if (Boolean.TRUE.equals(entry.getValue())) {
				core.add(ObsidianPlugins.core(entry.getKey()));
			}
		}
		List<CompatPlugin> community = new ArrayList<>();
		config.communityPlugins().forEach((id, name) -> community.add(ObsidianPlugins.community(id, name)));
		Comparator<CompatPlugin> order = Comparator.comparing((CompatPlugin p) -> rank(p.status()))
			.thenComparing(CompatPlugin::name, String.CASE_INSENSITIVE_ORDER);
		core.sort(order);
		community.sort(order);
		List<CompatPlugin> all = new ArrayList<>(core);
		all.addAll(community);
		return all;
	}

	private static int rank(CompatPlugin.Support support) {
		return switch (support) {
			case UNSUPPORTED -> 0;
			case UNKNOWN -> 1;
			case PLANNED -> 2;
			case PARTIAL -> 3;
			case SUPPORTED -> 4;
		};
	}

	/** The graph view's options from {@code graph.json}, only the keys it understands; null when there are none. */
	static @Nullable ObjectNode graph(@Nullable ObjectNode graph) {
		if (graph == null) {
			return null;
		}
		ObjectNode out = JsonNodeFactory.instance.objectNode();
		for (String key : GRAPH_KEYS.stream().sorted().toList()) {
			JsonNode value = graph.get(key);
			if (value != null && (value.isBoolean() || value.isNumber() || value.isString()
					|| (key.equals("colorGroups") && value.isArray()))) {
				out.set(key, value.deepCopy());
			}
		}
		return out.isEmpty() ? null : out;
	}

}
