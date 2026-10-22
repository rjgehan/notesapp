package com.rjgehan.notes.index;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

import com.rjgehan.notes.api.dto.FileKind;
import com.rjgehan.notes.api.dto.SearchCorrection;
import com.rjgehan.notes.api.dto.SearchHit;
import com.rjgehan.notes.api.dto.SearchResponse;
import com.rjgehan.notes.api.error.ErrorCode;
import com.rjgehan.notes.api.error.FieldError;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.config.NotesProperties;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.PathNames;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Service;

/**
 * {@code GET /api/search} (API.md §12.1): evaluates the query against the index, then builds snippets for the
 * returned page only, outside the index lock. Notes matching {@code settings.files.excludedPaths} are never returned.
 * Queries with regular expressions or {@code line:}/{@code section:} clauses read document text: they share one time
 * budget ({@code notes.search.timeout}) and only a few of them run at once.
 */
@Service
public class SearchService {

	private static final Logger logger = LoggerFactory.getLogger(SearchService.class);

	public static final int DEFAULT_LIMIT = 50;

	public static final int MAX_LIMIT = 200;

	private final VaultIndex index;

	private final SettingsService settings;

	private final Duration timeout;

	private final Semaphore expensive;

	public SearchService(VaultIndex index, SettingsService settings, NotesProperties properties) {
		this.index = index;
		this.settings = settings;
		this.timeout = properties.search().timeout();
		this.expensive = new Semaphore(Math.max(1, properties.search().maxConcurrentExpensive()), true);
	}

	/** {@code sort} is {@code relevance} or {@code mtime}. */
	public SearchResponse search(String query, int limit, String sort, boolean prefix, boolean fuzzy) {
		if (limit < 1 || limit > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		String order = sort.toLowerCase(Locale.ROOT);
		if (!order.equals("relevance") && !order.equals("mtime")) {
			throw NotesException.badRequest("sort must be relevance or mtime");
		}
		if (query.length() > SearchQueryParser.MAX_LENGTH) {
			throw invalidQuery("The query is longer than " + SearchQueryParser.MAX_LENGTH + " characters");
		}
		long started = System.nanoTime();
		SearchQuery parsed = SearchQueryParser.parse(query);
		List<SearchQuery.Leaf> leaves = parsed.leaves();
		if (leaves.size() > SearchQueryParser.MAX_CLAUSES) {
			throw invalidQuery("The query has more than " + SearchQueryParser.MAX_CLAUSES + " clauses");
		}
		boolean costly = parsed.readsText();
		FilesSettings files = this.settings.current().files();
		VaultIndex.SearchOptions options = new VaultIndex.SearchOptions(prefix, fuzzy, files::isExcluded,
				order.equals("mtime"), this.timeout);
		VaultIndex.SearchOutcome outcome;
		if (costly) {
			acquire();
		}
		try {
			outcome = this.index.search(parsed, options);
		}
		catch (SearchRegex.InvalidException ex) {
			throw invalidQuery(ex.getMessage());
		}
		catch (SearchRegex.TimeoutException ex) {
			// Search queries are never logged (DESIGN §5.18).
			logger.info("SEARCH timed out after {} ms", this.timeout.toMillis());
			throw invalidQuery("The search took too long. Simplify the regular expression (nested repetition such "
					+ "as (a+)+ is a common cause), or add words that narrow the search down.");
		}
		finally {
			if (costly) {
				this.expensive.release();
			}
		}
		List<SearchHit> results = new ArrayList<>();
		for (VaultIndex.SearchHit hit : outcome.hits().subList(0, Math.min(limit, outcome.hits().size()))) {
			NoteRecord note = hit.note();
			String basename = PathNames.basenameOf(PathNames.nameOf(note.path()));
			SnippetBuilder.Snippets snippets = SnippetBuilder.build(basename, note.searchText(), note.parse(),
					outcome.patterns(), outcome.regexes(), outcome.budget(), hit.kind() == FileKind.PDF);
			results.add(new SearchHit(note.path(), basename, hit.kind(), Math.round(hit.score() * 100) / 100.0,
					hit.mtime(), snippets.titleRanges(), snippets.matches(), snippets.moreMatches()));
		}
		List<SearchCorrection> corrections = outcome.corrections()
			.stream()
			.map((c) -> new SearchCorrection(c.term(), c.replacements()))
			.toList();
		long tookMs = (System.nanoTime() - started) / 1_000_000;
		return new SearchResponse(query, outcome.hits().size(), tookMs, results, corrections);
	}

	private void acquire() {
		try {
			if (!this.expensive.tryAcquire(this.timeout.toMillis(), TimeUnit.MILLISECONDS)) {
				throw NotesException.busy();
			}
		}
		catch (InterruptedException ex) {
			Thread.currentThread().interrupt();
			throw NotesException.busy();
		}
	}

	private static NotesException invalidQuery(String message) {
		return new NotesException(ErrorCode.BAD_REQUEST, message,
				Map.of("errors", List.of(new FieldError("q", message))));
	}

}
