// The active sheet's charts (DESIGN §6.21.9), in a pane below the grid that scrolls sideways and
// folds away. Each chart has Edit and Delete; the charts themselves are SheetChart.
import { ChevronDown, ChevronRight, Pencil, Trash } from 'lucide-react';
import { compareIds, type Sheet } from '../../sheets/format';
import { SheetChart } from './SheetChart';

interface Props {
  sheet: Sheet;
  editable: boolean;
  open: boolean;
  onToggle(): void;
  onEdit(id: string): void;
  onDelete(id: string): void;
}

export function ChartsPane({ sheet, editable, open, onToggle, onEdit, onDelete }: Props) {
  const charts = Object.entries(sheet.charts).sort(([a], [b]) => compareIds(a, b));
  if (charts.length === 0) return null;
  return (
    <section className={`sheet-charts${open ? ' is-open' : ''}`} aria-label="Charts">
      <button type="button" className="sheet-charts-toggle" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        Charts ({charts.length})
      </button>
      {open && (
        <div className="sheet-charts-list">
          {charts.map(([id, chart]) => (
            <div key={id} className="sheet-charts-card">
              <SheetChart
                sheet={sheet}
                chart={chart}
                height={150}
                actions={
                  editable && (
                    <>
                      <button type="button" className="icon-button" aria-label={`Edit chart ${chart.title ?? ''}`.trim()} title="Edit chart" onClick={() => onEdit(id)}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" className="icon-button" aria-label={`Delete chart ${chart.title ?? ''}`.trim()} title="Delete chart" onClick={() => onDelete(id)}>
                        <Trash size={14} />
                      </button>
                    </>
                  )
                }
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
