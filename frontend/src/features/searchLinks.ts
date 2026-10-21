// Where a search hit leads (API.md §12.1, DESIGN §6.4): a note opens at the matching line with
// the query's terms highlighted; a PDF opens at the matching page.
import type { SearchHit } from '../api/types';
import { noteRoute } from './paths';

/** The route of a hit, or of one of its matches. `highlight` is the query plus any typo replacements. */
export function hitRoute(hit: Pick<SearchHit, 'path' | 'kind'>, match: { line: number; page: number | null } | null, highlight: string): string {
  if (match === null) return noteRoute(hit.path);
  if (hit.kind === 'pdf') return match.page !== null ? noteRoute(hit.path) + `?page=${match.page}` : noteRoute(hit.path);
  return noteRoute(hit.path) + `?line=${match.line}&q=${encodeURIComponent(highlight)}`;
}

/** A PDF viewer URL at a page (the `#page=` fragment every built-in viewer reads). */
export function pdfViewerUrl(url: string, page: string | null): string {
  const n = page !== null ? Number.parseInt(page, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? `${url}#page=${n}` : url;
}
