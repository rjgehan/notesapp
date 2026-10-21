package com.rjgehan.notes.ai;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.Map;
import java.util.TreeMap;

import com.rjgehan.notes.vault.VaultFs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The estimated Claude spend per calendar month (in the server's time zone), for the monthly budget of
 * {@code settings.ai} (DESIGN §5.20). It lives in {@code .notesapp/cache/ai-usage.json}: inside the volume, so it
 * survives restarts and is in the backups, but excluded from git (§4.6), so it never becomes history or reaches the
 * mirror. It holds counts only, never a question or note text. Losing it resets this month's count to zero.
 */
@Component
public class UsageLedger {

	private static final Logger logger = LoggerFactory.getLogger(UsageLedger.class);

	public static final String FILE = ".notesapp/cache/ai-usage.json";

	/** Months kept in the file. */
	private static final int KEEP_MONTHS = 12;

	/** One month's totals. */
	public record Month(int requests, double costUsd, AiModels.Usage usage) {

		static final Month EMPTY = new Month(0, 0, AiModels.Usage.ZERO);

		Month plus(double cost, AiModels.Usage more) {
			return new Month(this.requests + 1, this.costUsd + cost, this.usage.plus(more));
		}

	}

	private final VaultFs fs;

	private final Clock clock;

	private final JsonMapper mapper;

	private final ZoneId zone;

	private Map<String, Month> months;

	private boolean loaded;

	@Autowired
	public UsageLedger(VaultFs fs, Clock clock, JsonMapper mapper) {
		this(fs, clock, mapper, ZoneId.systemDefault());
	}

	UsageLedger(VaultFs fs, Clock clock, JsonMapper mapper, ZoneId zone) {
		this.fs = fs;
		this.clock = clock;
		this.mapper = mapper;
		this.zone = zone;
		this.months = new TreeMap<>();
	}

	/** The current month as {@code 2026-10}. */
	public String currentMonth() {
		return YearMonth.from(LocalDate.ofInstant(this.clock.instant(), this.zone)).toString();
	}

	public synchronized Month thisMonth() {
		load();
		return this.months.getOrDefault(currentMonth(), Month.EMPTY);
	}

	/** Adds one request to this month and saves the file; returns the month's new totals. */
	public synchronized Month record(double costUsd, AiModels.Usage usage) {
		load();
		String month = currentMonth();
		Month updated = this.months.getOrDefault(month, Month.EMPTY).plus(costUsd, usage);
		this.months.put(month, updated);
		while (this.months.size() > KEEP_MONTHS) {
			this.months.remove(this.months.keySet().iterator().next());
		}
		save();
		return updated;
	}

	private void load() {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		try {
			JsonNode root = this.mapper.readTree(new String(this.fs.readBytes(FILE), StandardCharsets.UTF_8));
			JsonNode months = root.get("months");
			if (months != null && months.isObject()) {
				months.properties().forEach((entry) -> {
					JsonNode m = entry.getValue();
					this.months.put(entry.getKey(), new Month(m.path("requests").asInt(0),
							m.path("costUsd").asDouble(0),
							new AiModels.Usage(m.path("inputTokens").asLong(0), m.path("outputTokens").asLong(0),
									m.path("cacheReadInputTokens").asLong(0),
									m.path("cacheCreationInputTokens").asLong(0))));
				});
			}
		}
		catch (NoSuchFileException ex) {
			// Nothing spent yet.
		}
		catch (IOException | JacksonException ex) {
			logger.warn("{} could not be read ({}); this month's AI spend starts from zero", FILE,
					ex.getClass().getSimpleName());
		}
	}

	private void save() {
		ObjectNode root = this.mapper.createObjectNode();
		root.put("schemaVersion", 1);
		ObjectNode months = root.putObject("months");
		this.months.forEach((month, m) -> {
			ObjectNode node = months.putObject(month);
			node.put("requests", m.requests());
			node.put("costUsd", Math.round(m.costUsd() * 1_000_000) / 1_000_000.0);
			node.put("inputTokens", m.usage().inputTokens());
			node.put("outputTokens", m.usage().outputTokens());
			node.put("cacheReadInputTokens", m.usage().cacheReadInputTokens());
			node.put("cacheCreationInputTokens", m.usage().cacheCreationInputTokens());
		});
		try {
			Files.createDirectories(this.fs.resolve(FILE).getParent());
			this.fs.atomicWrite(FILE, (this.mapper.writeValueAsString(root) + "\n").getBytes(StandardCharsets.UTF_8));
		}
		catch (IOException | JacksonException ex) {
			logger.warn("{} could not be written ({}); the AI spend is counted in memory until it can", FILE,
					ex.getClass().getSimpleName());
		}
	}

}
