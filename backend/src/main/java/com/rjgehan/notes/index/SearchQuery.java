package com.rjgehan.notes.index;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

import org.jspecify.annotations.Nullable;

/**
 * A parsed search query (API.md §12.1): a tree of clauses joined by AND (juxtaposition) and {@code OR}, with
 * parentheses, negation and the {@code line:} / {@code section:} scopes. {@code root} is null for a query without
 * clauses.
 */
public record SearchQuery(@Nullable Node root) {

	public enum Kind {

		/** Notes containing the word; a word that tokenizes into several tokens acts as a phrase. */
		WORD,

		/** Consecutive tokens. */
		PHRASE,

		/** A regular expression over the text. */
		REGEX,

		/** Notes tagged {@code value} or any nested {@code value/…}; with {@code regex}, a tag matching it. */
		TAG,

		/** A case-insensitive substring of the full vault path; with {@code regex}, a path matching it. */
		PATH,

		/** A case-insensitive substring of the file name; with {@code regex}, a name matching it. */
		FILE,

		/**
		 * A frontmatter property (ROADMAP item 13, API.md §12.1): {@code value} is what was written between the
		 * brackets of {@code [name]}, {@code [name:value]} or {@code [name:"value"]}; see {@link PropertyClause}.
		 */
		PROPERTY

	}

	/** The unit a scoped clause must match within. */
	public enum Scope {

		/** One line of text. */
		LINE,

		/** The text between two headings (a page of a PDF). */
		SECTION

	}

	public sealed interface Node permits Leaf, And, Or, Not, Scoped {
	}

	/**
	 * One clause. {@code regex} is set for a {@code /regular expression/} value: always for {@link Kind#REGEX}, and for
	 * filters written as {@code path:/…/}. {@code last} marks the final clause of the query with nothing but
	 * whitespace or closing parentheses after it: a bare word there matches as a prefix (search-as-you-type).
	 */
	public record Leaf(Kind kind, String value, boolean regex, boolean last) implements Node {

		public boolean isText() {
			return this.kind == Kind.WORD || this.kind == Kind.PHRASE;
		}

	}

	/** Every child must match; negated children only remove matches. */
	public record And(List<Node> children) implements Node {

		public And {
			children = List.copyOf(children);
		}

	}

	/** At least one child must match. */
	public record Or(List<Node> children) implements Node {

		public Or {
			children = List.copyOf(children);
		}

	}

	/** A negated clause or group. */
	public record Not(Node child) implements Node {
	}

	/** {@code line:(…)} or {@code section:(…)}: the child must match within one line or section. */
	public record Scoped(Scope scope, Node child) implements Node {
	}

	/** True when nothing positive is asked for: the query matches no notes at all. */
	public boolean matchesNothing() {
		return this.root == null || !hasPositive(this.root, false);
	}

	/** True when evaluating the query reads document text: it has a regular expression or a scope. */
	public boolean readsText() {
		return this.root != null && readsText(this.root);
	}

	private static boolean readsText(Node node) {
		return switch (node) {
			case Leaf leaf -> leaf.regex();
			case And and -> and.children().stream().anyMatch(SearchQuery::readsText);
			case Or or -> or.children().stream().anyMatch(SearchQuery::readsText);
			case Not not -> readsText(not.child());
			case Scoped scoped -> true;
		};
	}

	/** Every clause, in query order. */
	public List<Leaf> leaves() {
		List<Leaf> leaves = new ArrayList<>();
		if (this.root != null) {
			visit(this.root, leaves::add);
		}
		return leaves;
	}

	private static boolean hasPositive(Node node, boolean negated) {
		return switch (node) {
			case Leaf leaf -> !negated;
			case And and -> and.children().stream().anyMatch((child) -> hasPositive(child, negated));
			case Or or -> or.children().stream().anyMatch((child) -> hasPositive(child, negated));
			case Not not -> hasPositive(not.child(), !negated);
			case Scoped scoped -> hasPositive(scoped.child(), negated);
		};
	}

	private static void visit(Node node, Consumer<Leaf> action) {
		switch (node) {
			case Leaf leaf -> action.accept(leaf);
			case And and -> and.children().forEach((child) -> visit(child, action));
			case Or or -> or.children().forEach((child) -> visit(child, action));
			case Not not -> visit(not.child(), action);
			case Scoped scoped -> visit(scoped.child(), action);
		}
	}

}
