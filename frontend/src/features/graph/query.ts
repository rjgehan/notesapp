// Graph filter and color-group queries (ROADMAP item 16, DESIGN §6.28): the search grammar of
// API.md §12.1 (words, "phrases", tag:, path:, file:, -negation; every clause must match),
// evaluated on the device against what the graph knows about a node: its name, path, aliases and
// tags. Note text is not searched, so the graph filters instantly and works for attachments,
// unresolved links and tag nodes too.

export interface QueryNode {
  /** Vault path; for unresolved nodes the link target, for tag nodes ''. */
  path: string;
  label: string;
  type: 'note' | 'attachment' | 'unresolved' | 'tag';
  tags: readonly string[];
  aliases: readonly string[];
}

type Kind = 'text' | 'tag' | 'path' | 'file';

export interface Clause {
  kind: Kind;
  value: string;
  negated: boolean;
}

/** Lower case without accents or width differences, like the server's tokenizer (NFKD, no marks). */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const FILTER = /^(tag|path|file):/i;

export function parseQuery(query: string): Clause[] {
  const clauses: Clause[] = [];
  let i = 0;
  const n = query.length;
  while (i < n) {
    while (i < n && /\s/.test(query[i]!)) i++;
    if (i >= n) break;
    let negated = false;
    if (query[i] === '-' && i + 1 < n && !/\s/.test(query[i + 1]!)) {
      negated = true;
      i++;
    }
    let kind: Kind = 'text';
    const filter = FILTER.exec(query.slice(i));
    if (filter) {
      kind = filter[1]!.toLowerCase() as Kind;
      i += filter[0].length;
    }
    let value: string;
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      value = end < 0 ? query.slice(i + 1) : query.slice(i + 1, end);
      i = end < 0 ? n : end + 1;
    } else {
      const start = i;
      while (i < n && !/\s/.test(query[i]!) && query[i] !== '"') i++;
      value = query.slice(start, i);
    }
    if (kind === 'tag') value = value.replace(/^#/, '');
    value = value.trim();
    if (value !== '') clauses.push({ kind, value: fold(value), negated });
  }
  return clauses;
}

function nameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function clauseMatches(c: Clause, node: QueryNode): boolean {
  switch (c.kind) {
    case 'tag': {
      const tags = node.type === 'tag' ? [node.label.replace(/^#/, '')] : node.tags;
      return tags.some((t) => {
        const f = fold(t);
        return f === c.value || f.startsWith(c.value + '/');
      });
    }
    case 'path':
      return node.type !== 'tag' && fold(node.path).includes(c.value);
    case 'file':
      return node.type !== 'tag' && fold(nameOf(node.path)).includes(c.value);
    case 'text': {
      if (fold(node.label).includes(c.value)) return true;
      if (node.type !== 'tag' && fold(node.path).includes(c.value)) return true;
      if (node.aliases.some((a) => fold(a).includes(c.value))) return true;
      return node.tags.some((t) => fold('#' + t).includes(c.value));
    }
  }
}

/** A predicate for a query; an empty query matches everything. */
export function compileQuery(query: string): (node: QueryNode) => boolean {
  const clauses = parseQuery(query);
  if (clauses.length === 0) return () => true;
  const positive = clauses.filter((c) => !c.negated);
  const negative = clauses.filter((c) => c.negated);
  return (node) => positive.every((c) => clauseMatches(c, node)) && !negative.some((c) => clauseMatches(c, node));
}

/** True when the query has at least one clause (an all-whitespace query filters nothing). */
export function isActiveQuery(query: string): boolean {
  return parseQuery(query).length > 0;
}
