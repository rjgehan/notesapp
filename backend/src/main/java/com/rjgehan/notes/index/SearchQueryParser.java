package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;

/**
 * The normative query grammar of API.md §12.1:
 *
 * <pre>
 * query   = ws* [ clause { ws+ clause } ] ws*
 * clause  = [ "-" ] ( filter | phrase | word )
 * filter  = ( "tag:" | "path:" | "file:" ) ( phrase | word )          ; keywords are case-insensitive
 * phrase  = '"' { char - '"' } ( '"' | end-of-query )                  ; an unterminated phrase runs to the end
 * word    = 1*( char - ws - '"' )
 * </pre>
 *
 * Parsing never fails: a keyword with nothing after it is an ordinary word, and an empty phrase is ignored.
 */
public final class SearchQueryParser {

	private static final String[] KEYWORDS = { "tag:", "path:", "file:" };

	private static final SearchQuery.Kind[] FILTERS = { SearchQuery.Kind.TAG, SearchQuery.Kind.PATH,
			SearchQuery.Kind.FILE };

	private SearchQueryParser() {
	}

	public static SearchQuery parse(String query) {
		List<SearchQuery.Clause> clauses = new ArrayList<>();
		int n = query.length();
		int i = 0;
		while (true) {
			while (i < n && Syntax.isWhitespace(query.charAt(i))) {
				i++;
			}
			if (i >= n) {
				break;
			}
			boolean negated = false;
			if (query.charAt(i) == '-' && i + 1 < n && !Syntax.isWhitespace(query.charAt(i + 1))) {
				negated = true;
				i++;
			}
			SearchQuery.Kind filter = null;
			for (int k = 0; k < KEYWORDS.length; k++) {
				int end = i + KEYWORDS[k].length();
				if (query.regionMatches(true, i, KEYWORDS[k], 0, KEYWORDS[k].length()) && end < n
						&& !Syntax.isWhitespace(query.charAt(end))) {
					filter = FILTERS[k];
					i = end;
					break;
				}
			}
			String value;
			SearchQuery.Kind kind;
			if (query.charAt(i) == '"') {
				int close = query.indexOf('"', i + 1);
				value = (close < 0) ? query.substring(i + 1) : query.substring(i + 1, close);
				i = (close < 0) ? n : close + 1;
				kind = (filter != null) ? filter : SearchQuery.Kind.PHRASE;
			}
			else {
				int start = i;
				while (i < n && !Syntax.isWhitespace(query.charAt(i)) && query.charAt(i) != '"') {
					i++;
				}
				value = query.substring(start, i);
				kind = (filter != null) ? filter : SearchQuery.Kind.WORD;
			}
			if (!value.isBlank()) {
				clauses.add(new SearchQuery.Clause(kind, value, negated));
			}
		}
		return new SearchQuery(clauses);
	}

}
