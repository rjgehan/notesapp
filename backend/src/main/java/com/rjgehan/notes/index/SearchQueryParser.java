package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;

import com.rjgehan.notes.index.SearchQuery.Kind;
import com.rjgehan.notes.index.SearchQuery.Leaf;
import com.rjgehan.notes.index.SearchQuery.Node;
import com.rjgehan.notes.index.SearchQuery.Scope;
import org.jspecify.annotations.Nullable;

/**
 * The normative query grammar of API.md §12.1:
 *
 * <pre>
 * query   = ws* [ or ] ws*
 * or      = and { ws+ "OR" ws+ and }                                ; OR (upper case) binds looser than AND
 * and     = unary { ws* unary }
 * unary   = [ "-" ] primary                                         ; "-" followed by whitespace is a word
 * primary = group | scoped | clause
 * group   = "(" ws* [ or ] ws* ( ")" | end-of-query )
 * scoped  = ( "line:" | "section:" ) ( group | clause )
 * clause  = [ "tag:" | "path:" | "file:" ] ( regex | phrase | word ) ; keywords are case-insensitive
 * regex   = "/" 1*( "\" char | char - "/" ) "/"                     ; only before ws, ")" or the end; else a word
 * phrase  = '"' { char - '"' } ( '"' | end-of-query )              ; an unterminated phrase runs to the end
 * word    = 1*( char - ws - '"' )                                   ; inside a group, ")" also ends a word
 * </pre>
 *
 * Parsing never fails: a keyword with nothing after it is an ordinary word, an empty phrase or group is ignored, an
 * unclosed group runs to the end, a stray {@code )} is ignored, and a leading, trailing or doubled {@code OR} is
 * dropped. Whether a regular expression is valid is checked when the query is evaluated.
 */
public final class SearchQueryParser {

	/** The longest query accepted. */
	public static final int MAX_LENGTH = 2000;

	/** The most clauses one query may have. */
	public static final int MAX_CLAUSES = 64;

	private static final String[] FILTER_KEYWORDS = { "tag:", "path:", "file:" };

	private static final Kind[] FILTERS = { Kind.TAG, Kind.PATH, Kind.FILE };

	private static final String[] SCOPE_KEYWORDS = { "line:", "section:" };

	private static final Scope[] SCOPES = { Scope.LINE, Scope.SECTION };

	private final String q;

	private final int n;

	/** From here on only whitespace and {@code )} remain: a clause ending here is the query's last. */
	private final int trailing;

	private int i;

	private int depth;

	private SearchQueryParser(String query) {
		this.q = query;
		this.n = query.length();
		int t = this.n;
		while (t > 0 && (Syntax.isWhitespace(query.charAt(t - 1)) || query.charAt(t - 1) == ')')) {
			t--;
		}
		this.trailing = t;
	}

	public static SearchQuery parse(String query) {
		SearchQueryParser parser = new SearchQueryParser(query);
		return new SearchQuery(parser.or());
	}

	// ---------------------------------------------------------------- grammar

	/** {@code or}; inside a group it consumes the closing parenthesis. */
	private @Nullable Node or() {
		List<Node> alternatives = new ArrayList<>();
		List<Node> current = new ArrayList<>();
		while (true) {
			skipWhitespace();
			if (this.i >= this.n) {
				break;
			}
			char c = this.q.charAt(this.i);
			if (c == ')') {
				this.i++;
				if (this.depth > 0) {
					break;
				}
				continue;
			}
			if (atOr()) {
				this.i += 2;
				if (!current.isEmpty()) {
					alternatives.add(and(current));
					current = new ArrayList<>();
				}
				continue;
			}
			Node node = unary();
			if (node != null) {
				current.add(node);
			}
		}
		if (!current.isEmpty()) {
			alternatives.add(and(current));
		}
		if (alternatives.isEmpty()) {
			return null;
		}
		return (alternatives.size() == 1) ? alternatives.get(0) : new SearchQuery.Or(alternatives);
	}

	private static Node and(List<Node> nodes) {
		return (nodes.size() == 1) ? nodes.get(0) : new SearchQuery.And(nodes);
	}

	private @Nullable Node unary() {
		boolean negated = false;
		if (this.q.charAt(this.i) == '-' && this.i + 1 < this.n && !Syntax.isWhitespace(this.q.charAt(this.i + 1))
				&& this.q.charAt(this.i + 1) != ')') {
			negated = true;
			this.i++;
		}
		Node node = primary();
		if (node == null) {
			return null;
		}
		return negated ? new SearchQuery.Not(node) : node;
	}

	private @Nullable Node primary() {
		if (this.q.charAt(this.i) == '(') {
			return group();
		}
		for (int k = 0; k < SCOPE_KEYWORDS.length; k++) {
			if (atKeyword(SCOPE_KEYWORDS[k])) {
				this.i += SCOPE_KEYWORDS[k].length();
				Node child = (this.q.charAt(this.i) == '(') ? group() : clause();
				return (child != null) ? new SearchQuery.Scoped(SCOPES[k], child) : null;
			}
		}
		return clause();
	}

	private @Nullable Node group() {
		this.i++;
		this.depth++;
		Node inner = or();
		this.depth--;
		return inner;
	}

	private @Nullable Node clause() {
		Kind filter = null;
		for (int k = 0; k < FILTER_KEYWORDS.length; k++) {
			if (atKeyword(FILTER_KEYWORDS[k])) {
				filter = FILTERS[k];
				this.i += FILTER_KEYWORDS[k].length();
				break;
			}
		}
		char c = this.q.charAt(this.i);
		if (c == '/') {
			int end = regexEnd(this.i);
			if (end > 0) {
				String value = this.q.substring(this.i + 1, end);
				this.i = end + 1;
				return new Leaf((filter != null) ? filter : Kind.REGEX, value, true, false);
			}
		}
		String value;
		Kind kind;
		boolean last;
		if (c == '"') {
			int close = this.q.indexOf('"', this.i + 1);
			value = (close < 0) ? this.q.substring(this.i + 1) : this.q.substring(this.i + 1, close);
			this.i = (close < 0) ? this.n : close + 1;
			kind = (filter != null) ? filter : Kind.PHRASE;
			last = false;
		}
		else {
			int start = this.i;
			while (this.i < this.n) {
				char ch = this.q.charAt(this.i);
				if (Syntax.isWhitespace(ch) || ch == '"' || (ch == ')' && this.depth > 0)) {
					break;
				}
				this.i++;
			}
			value = this.q.substring(start, this.i);
			kind = (filter != null) ? filter : Kind.WORD;
			last = this.i >= this.trailing;
		}
		if (value.isBlank()) {
			return null;
		}
		return new Leaf(kind, value, false, last);
	}

	// ---------------------------------------------------------------- lexing

	private void skipWhitespace() {
		while (this.i < this.n && Syntax.isWhitespace(this.q.charAt(this.i))) {
			this.i++;
		}
	}

	/** A keyword (case-insensitive) with something after it that is not whitespace. */
	private boolean atKeyword(String keyword) {
		int end = this.i + keyword.length();
		return this.q.regionMatches(true, this.i, keyword, 0, keyword.length()) && end < this.n
				&& !Syntax.isWhitespace(this.q.charAt(end));
	}

	/** {@code OR} in upper case, standing on its own. */
	private boolean atOr() {
		if (!this.q.startsWith("OR", this.i)) {
			return false;
		}
		int end = this.i + 2;
		if (end == this.n) {
			return true;
		}
		char next = this.q.charAt(end);
		return Syntax.isWhitespace(next) || next == '(' || next == '"' || (next == ')' && this.depth > 0);
	}

	/**
	 * The index of the slash that closes a regular expression starting at {@code start}, or -1. Backslash escapes are
	 * skipped; the closing slash must be followed by whitespace, a {@code )} or the end of the query, so a path such
	 * as {@code /usr/bin} stays a word.
	 */
	private int regexEnd(int start) {
		for (int k = start + 1; k < this.n; k++) {
			char ch = this.q.charAt(k);
			if (ch == '\\') {
				k++;
				continue;
			}
			if (ch == '/') {
				if (k == start + 1) {
					return -1;
				}
				if (k + 1 == this.n || Syntax.isWhitespace(this.q.charAt(k + 1)) || this.q.charAt(k + 1) == ')') {
					return k;
				}
				return -1;
			}
		}
		return -1;
	}

}
