// The selection as HTML, kept apart from extract.ts so the bookmarklet stays a few hundred bytes.

/** The current selection of `win` as HTML, or `''` when nothing is selected. */
export function selectionHtml(win: Window): string {
  const sel = win.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const div = win.document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) div.appendChild(sel.getRangeAt(i).cloneContents());
  return div.innerHTML;
}
