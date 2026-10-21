// Query key factory (DESIGN §6.3).

export const queryKeys = {
  tree: () => ['tree'] as const,
  file: (path: string) => ['file', path] as const,
  meta: (path: string) => ['meta', path] as const,
  backlinksAll: () => ['backlinks'] as const,
  backlinks: (path: string, unlinked: boolean) => ['backlinks', path, unlinked] as const,
  searchAll: () => ['search'] as const,
  search: (q: string, sort: 'relevance' | 'mtime') => ['search', q, sort] as const,
  tags: () => ['tags'] as const,
  historyAll: () => ['history'] as const,
  history: (path: string) => ['history', path] as const,
  historyContent: (commit: string, path: string) => ['historyContent', commit, path] as const,
  trash: () => ['trash'] as const,
  settings: () => ['settings'] as const,
  me: () => ['me'] as const,
  status: () => ['status'] as const,
  templates: () => ['templates'] as const,
  bookmarks: () => ['bookmarks'] as const,
};

export const STALE = {
  tree: Infinity,
  file: Infinity,
  meta: 30_000,
  backlinks: 0,
  search: 10_000,
  tags: 30_000,
  history: 0,
  historyContent: Infinity,
  trash: 60_000,
  settings: Infinity,
  me: Infinity,
  status: 10_000,
  templates: 60_000,
  bookmarks: Infinity,
} as const;
