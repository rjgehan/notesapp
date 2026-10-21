// The search query grammar of API.md §12.1, parsed exactly as the server does
// (SearchQueryParser.java): words, "phrases", /regular expressions/, tag:/path:/file: filters,
// -negation, OR, parentheses and the line:/section: scopes. Parsing never fails. The client uses
// it to highlight what a query matched, to describe it, and in the dev-only mock API.

export type LeafKind = 'word' | 'phrase' | 'regex' | 'tag' | 'path' | 'file';

export type QueryNode =
  | { type: 'leaf'; kind: LeafKind; value: string; regex: boolean; last: boolean }
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] }
  | { type: 'not'; child: QueryNode }
  | { type: 'scope'; scope: 'line' | 'section'; child: QueryNode };

export type QueryLeaf = Extract<QueryNode, { type: 'leaf' }>;

// JavaScript's \s is exactly the server's whitespace set (Syntax.isWhitespace).
const WS = /\s/;
const FILTERS: Array<[string, LeafKind]> = [
  ['tag:', 'tag'],
  ['path:', 'path'],
  ['file:', 'file'],
];
const SCOPES: Array<[string, 'line' | 'section']> = [
  ['line:', 'line'],
  ['section:', 'section'],
];

const isWs = (c: string | undefined): boolean => c !== undefined && WS.test(c);

export function parseSearchQuery(q: string): QueryNode | null {
  const n = q.length;
  let trailing = n;
  while (trailing > 0 && (isWs(q[trailing - 1]) || q[trailing - 1] === ')')) trailing--;
  let i = 0;
  let depth = 0;

  const atKeyword = (keyword: string): boolean =>
    q.slice(i, i + keyword.length).toLowerCase() === keyword && i + keyword.length < n && !isWs(q[i + keyword.length]);

  const atOr = (): boolean => {
    if (!q.startsWith('OR', i)) return false;
    const next = q[i + 2];
    return next === undefined || isWs(next) || next === '(' || next === '"' || (next === ')' && depth > 0);
  };

  const regexEnd = (start: number): number => {
    for (let k = start + 1; k < n; k++) {
      const ch = q[k];
      if (ch === '\\') {
        k++;
        continue;
      }
      if (ch === '/') {
        if (k === start + 1) return -1;
        if (k + 1 === n || isWs(q[k + 1]) || q[k + 1] === ')') return k;
        return -1;
      }
    }
    return -1;
  };

  const and = (nodes: QueryNode[]): QueryNode => (nodes.length === 1 ? nodes[0] : { type: 'and', children: nodes });

  function or(): QueryNode | null {
    const alternatives: QueryNode[] = [];
    let current: QueryNode[] = [];
    for (;;) {
      while (i < n && isWs(q[i])) i++;
      if (i >= n) break;
      if (q[i] === ')') {
        i++;
        if (depth > 0) break;
        continue;
      }
      if (atOr()) {
        i += 2;
        if (current.length > 0) {
          alternatives.push(and(current));
          current = [];
        }
        continue;
      }
      const node = unary();
      if (node) current.push(node);
    }
    if (current.length > 0) alternatives.push(and(current));
    if (alternatives.length === 0) return null;
    return alternatives.length === 1 ? alternatives[0] : { type: 'or', children: alternatives };
  }

  function unary(): QueryNode | null {
    let negated = false;
    if (q[i] === '-' && i + 1 < n && !isWs(q[i + 1]) && q[i + 1] !== ')') {
      negated = true;
      i++;
    }
    const node = primary();
    if (!node) return null;
    return negated ? { type: 'not', child: node } : node;
  }

  function group(): QueryNode | null {
    i++;
    depth++;
    const inner = or();
    depth--;
    return inner;
  }

  function primary(): QueryNode | null {
    if (q[i] === '(') return group();
    for (const [keyword, scope] of SCOPES) {
      if (atKeyword(keyword)) {
        i += keyword.length;
        const child = q[i] === '(' ? group() : clause();
        return child ? { type: 'scope', scope, child } : null;
      }
    }
    return clause();
  }

  function clause(): QueryNode | null {
    let filter: LeafKind | null = null;
    for (const [keyword, kind] of FILTERS) {
      if (atKeyword(keyword)) {
        filter = kind;
        i += keyword.length;
        break;
      }
    }
    if (q[i] === '/') {
      const end = regexEnd(i);
      if (end > 0) {
        const value = q.slice(i + 1, end);
        i = end + 1;
        return { type: 'leaf', kind: filter ?? 'regex', value, regex: true, last: false };
      }
    }
    let value: string;
    let kind: LeafKind;
    let last = false;
    if (q[i] === '"') {
      const close = q.indexOf('"', i + 1);
      value = close < 0 ? q.slice(i + 1) : q.slice(i + 1, close);
      i = close < 0 ? n : close + 1;
      kind = filter ?? 'phrase';
    } else {
      const start = i;
      while (i < n && !isWs(q[i]) && q[i] !== '"' && !(q[i] === ')' && depth > 0)) i++;
      value = q.slice(start, i);
      kind = filter ?? 'word';
      last = i >= trailing;
    }
    if (value.trim() === '') return null;
    return { type: 'leaf', kind, value, regex: false, last };
  }

  return or();
}

/** Every clause of a query with whether it is negated, in query order. */
export function queryLeaves(node: QueryNode | null): Array<{ leaf: QueryLeaf; negated: boolean; scoped: boolean }> {
  const out: Array<{ leaf: QueryLeaf; negated: boolean; scoped: boolean }> = [];
  const visit = (n: QueryNode, negated: boolean, scoped: boolean): void => {
    switch (n.type) {
      case 'leaf':
        out.push({ leaf: n, negated, scoped });
        return;
      case 'and':
      case 'or':
        for (const c of n.children) visit(c, negated, scoped);
        return;
      case 'not':
        visit(n.child, !negated, scoped);
        return;
      case 'scope':
        visit(n.child, negated, true);
        return;
    }
  };
  if (node) visit(node, false, false);
  return out;
}

/**
 * A server-side (Java) regular expression as a JavaScript one for highlighting: case-insensitive
 * unless it starts with `(?-i)`, multiline, global. Null when JavaScript cannot compile it.
 */
export function toJsRegExp(source: string): RegExp | null {
  let flags = 'gimu';
  let body = source;
  const inline = /^\(\?([a-z]*)(?:-([a-z]+))?\)/.exec(body);
  if (inline) {
    body = body.slice(inline[0].length);
    if (inline[2]?.includes('i')) flags = flags.replace('i', '');
  }
  try {
    return new RegExp(body, flags);
  } catch {
    try {
      return new RegExp(body, flags.replace('u', ''));
    } catch {
      return null;
    }
  }
}
