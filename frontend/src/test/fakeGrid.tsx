// A stand-in for Glide Data Grid in component tests: jsdom has no canvas. It renders the top-left
// cells as text and keeps the props it was given, so a test can call the grid's callbacks the way
// Glide would.
import type { DataEditorProps, DataEditorRef } from '@glideapps/glide-data-grid';
import { forwardRef, useImperativeHandle } from 'react';

/** `mouseArgs`: what getMouseArgsForPosition reports for a point (a test sets it). */
export const fakeGrid: { props: DataEditorProps | null; focused: number; mouseArgs?: (x: number, y: number) => ReturnType<DataEditorRef['getMouseArgsForPosition']> } = { props: null, focused: 0 };

/** The latest props, for calling Glide's callbacks. */
export function gridProps(): DataEditorProps {
  if (!fakeGrid.props) throw new Error('The grid has not rendered');
  return fakeGrid.props;
}

export const FakeDataEditor = forwardRef<DataEditorRef, DataEditorProps>(function FakeDataEditor(props, ref) {
  fakeGrid.props = props;
  useImperativeHandle(ref, () => ({
    focus: () => {
      fakeGrid.focused++;
      document.querySelector<HTMLElement>('[data-testid="grid"]')?.focus();
    },
    scrollTo: () => {},
    updateCells: () => {},
    getBounds: () => undefined,
    emit: async () => {},
    appendRow: async () => {},
    appendColumn: async () => {},
    remeasureColumns: () => {},
    getMouseArgsForPosition: (x: number, y: number) => fakeGrid.mouseArgs?.(x, y),
  }));
  const rows = Array.from({ length: Math.min(props.rows, 6) }, (_, r) => r);
  const cols = props.columns.slice(0, 4);
  return (
    <div data-testid="grid" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.title}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              {cols.map((c, i) => {
                const cell = props.getCellContent([i, r]);
                return (
                  <td key={c.title} data-testid={`cell-${c.title}${r}`}>
                    {'displayData' in cell ? String(cell.displayData) : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
