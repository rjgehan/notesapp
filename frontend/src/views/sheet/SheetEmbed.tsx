// `![[Budget.sheet]]`, `![[Budget.sheet#Summary]]` and `![[Budget.sheet#Budget!A1:C10]]` in notes
// (ROADMAP item 6b, DESIGN §6.21.7): a read-only table of the first sheet's used range, a named
// sheet or a range, from the cached values in the file, in their number formats; a whole sheet
// also shows its charts. The descriptor's loadEmbed() chunk: it never loads the formula engine or
// the grid. A click anywhere opens the spreadsheet at that sheet or range; the embed handles its
// own clicks, so it works in any host (the reading view, Live Preview).
import '../../styles/sheetEmbed.css';
import { FileSpreadsheet } from 'lucide-react';
import { useMemo, type MouseEvent } from 'react';
import { useTextFile } from '../../api/hooks';
import { openPath } from '../../features/navigation';
import { displayName, noteRoute } from '../../features/paths';
import { columnLetters } from '../../sheets/a1';
import { shownCell } from '../../sheets/display';
import { compareIds, parseSheet } from '../../sheets/format';
import { rangeText } from '../../sheets/refs';
import { resolveTarget, usedRange } from '../../sheets/target';
import type { EmbedProps } from '../registry';
import { SheetChart } from './SheetChart';

/** An embed shows at most this many rows and columns; the spreadsheet has the rest. */
export const EMBED_ROWS = 100;
export const EMBED_COLUMNS = 26;

const SIZE = /^\d+(x\d+)?$/;

export default function SheetEmbed({ path, subpath, display }: EmbedProps) {
  const file = useTextFile(path);
  const content = file.data?.content;
  const parsed = useMemo(() => (content === undefined ? null : parseSheet(content)), [content]);
  const target = parsed?.ok ? resolveTarget(parsed.file, subpath) : null;
  const caption = display && !SIZE.test(display.trim()) ? display : displayName(path) + (subpath ? ` › ${subpath}` : '');

  const open = (e: MouseEvent) => {
    // The host (the reading view) must not follow the title link a second time.
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    // Selecting text in the table is not a click on it.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
    e.preventDefault();
    openPath(path, subpath ?? null);
  };

  let body;
  if (file.isError) body = <div className="markdown-embed-empty">Could not load this spreadsheet.</div>;
  else if (!parsed) body = <div className="embed-loading">Loading…</div>;
  else if (!parsed.ok) body = <div className="markdown-embed-empty">This file cannot be shown as a spreadsheet. {parsed.error}</div>;
  else if (!target) body = <div className="markdown-embed-empty">“{subpath}” is not a sheet, named range or range in this spreadsheet.</div>;
  else {
    const { sheet } = target;
    const range = target.range ?? usedRange(sheet);
    const charts = target.range === null ? Object.entries(sheet.charts).sort(([a], [b]) => compareIds(a, b)) : [];
    const rows = range ? Math.min(range.height, EMBED_ROWS) : 0;
    const cols = range ? Math.min(range.width, EMBED_COLUMNS) : 0;
    body = (
      <>
        {range === null ? (
          <div className="markdown-embed-empty">This sheet is empty.</div>
        ) : (
          <div className="sheet-embed-scroll">
            <table className="sheet-embed-table">
              <colgroup>
                {Array.from({ length: cols }, (_, j) => {
                  const w = sheet.cols[columnLetters(range.col + j)]?.w;
                  return <col key={j} style={w ? { width: `${w}px` } : undefined} />;
                })}
              </colgroup>
              <tbody>
                {Array.from({ length: rows }, (_, i) => {
                  const row = range.row + i;
                  const boldRow = sheet.rows[String(row + 1)]?.bold === true;
                  return (
                    <tr key={row} className={boldRow ? 'is-bold' : undefined}>
                      {Array.from({ length: cols }, (_, j) => {
                        const col = range.col + j;
                        const shown = shownCell(sheet, col, row);
                        const bold = !boldRow && sheet.cols[columnLetters(col)]?.bold === true;
                        const classes = [`align-${shown.align}`, shown.color ? `is-${shown.color}` : '', bold ? 'is-bold' : ''].filter(Boolean).join(' ');
                        return (
                          <td key={col} className={classes}>
                            {shown.text}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {range && (range.height > rows || range.width > cols) && (
          <p className="sheet-embed-note">
            Showing {rangeText({ ...range, height: rows, width: cols })} of {rangeText(range)}. Open the spreadsheet for the rest.
          </p>
        )}
        {charts.length > 0 && (
          <div className="sheet-embed-charts">
            {charts.map(([id, chart]) => (
              <SheetChart key={id} sheet={sheet} chart={chart} height={180} />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="markdown-embed sheet-embed" data-source={path} onClick={open} title="Open the spreadsheet">
      <a className="markdown-embed-title internal-link" data-href={path + (subpath ? '#' + subpath : '')} href={noteRoute(path, subpath)} onClick={open}>
        <FileSpreadsheet size={14} aria-hidden />
        <span>{caption}</span>
      </a>
      {body}
    </div>
  );
}
