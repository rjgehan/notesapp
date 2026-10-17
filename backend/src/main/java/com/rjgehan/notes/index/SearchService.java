package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.rjgehan.notes.api.dto.SearchHit;
import com.rjgehan.notes.api.dto.SearchResponse;
import com.rjgehan.notes.api.error.NotesException;
import com.rjgehan.notes.settings.FilesSettings;
import com.rjgehan.notes.settings.SettingsService;
import com.rjgehan.notes.vault.PathNames;

import org.springframework.stereotype.Service;

/**
 * {@code GET /api/search} (API.md §12.1): evaluates the query against the index, then builds snippets for the
 * returned page only, outside the index lock. Notes matching {@code settings.files.excludedPaths} are never returned.
 */
@Service
public class SearchService {

	public static final int DEFAULT_LIMIT = 50;

	public static final int MAX_LIMIT = 200;

	private final VaultIndex index;

	private final SettingsService settings;

	public SearchService(VaultIndex index, SettingsService settings) {
		this.index = index;
		this.settings = settings;
	}

	/** {@code sort} is {@code relevance} or {@code mtime}. */
	public SearchResponse search(String query, int limit, String sort, boolean prefix) {
		if (limit < 1 || limit > MAX_LIMIT) {
			throw NotesException.badRequest("limit must be between 1 and " + MAX_LIMIT);
		}
		String order = sort.toLowerCase(Locale.ROOT);
		if (!order.equals("relevance") && !order.equals("mtime")) {
			throw NotesException.badRequest("sort must be relevance or mtime");
		}
		long started = System.nanoTime();
		FilesSettings files = this.settings.current().files();
		VaultIndex.SearchOutcome outcome = this.index.search(SearchQueryParser.parse(query), prefix,
				files::isExcluded, order.equals("mtime"));
		List<SearchHit> results = new ArrayList<>();
		for (VaultIndex.SearchHit hit : outcome.hits().subList(0, Math.min(limit, outcome.hits().size()))) {
			NoteRecord note = hit.note();
			String basename = PathNames.basenameOf(PathNames.nameOf(note.path()));
			SnippetBuilder.Snippets snippets = SnippetBuilder.build(basename, note.text(), note.parse(),
					outcome.patterns());
			results.add(new SearchHit(note.path(), basename, Math.round(hit.score() * 100) / 100.0, hit.mtime(),
					snippets.titleRanges(), snippets.matches(), snippets.moreMatches()));
		}
		long tookMs = (System.nanoTime() - started) / 1_000_000;
		return new SearchResponse(query, outcome.hits().size(), tookMs, results);
	}

}
