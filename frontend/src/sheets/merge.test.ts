import { describe, expect, it } from 'vitest';
import { parseSheet, serializeSheet, SHEET_ENGINE, type SheetFile } from './format';
import { mergeSheetText } from './merge';

const ENGINE = SHEET_ENGINE;

function base(): SheetFile {
  const result = parseSheet(
    JSON.stringify({
      type: 'notesapp-sheet',
      version: 1,
      engine: ENGINE,
      sheets: [
        {
          id: 's1',
          name: 'Budget',
          cells: { A1: { v: 'Item' }, B1: { v: 'Cost' }, A2: { v: 'Rent' }, B2: { v: 1450 }, A3: { v: 'Food' }, B3: { v: 300 }, B10: { f: '=SUM(B2:B9)', c: 1750 } },
          cols: { A: { w: 180 } },
          rows: {},
          frozen: { rows: 1, cols: 0 },
        },
        { id: 's2', name: 'Notes', cells: { A1: { v: 'hello' } } },
      ],
      named: { Total: 'Budget!$B$10' },
    }),
  );
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

/** A copy of the base after `edit`, as text. */
function edited(edit: (f: SheetFile) => void): string {
  const file = base();
  edit(file);
  return serializeSheet(file);
}

function merge(mine: (f: SheetFile) => void, theirs: (f: SheetFile) => void): SheetFile | null {
  const text = mergeSheetText(serializeSheet(base()), edited(mine), edited(theirs));
  if (text === null) return null;
  const result = parseSheet(text);
  if (!result.ok) throw new Error(result.error);
  expect(result.repairs).toEqual([]);
  return result.file;
}

const budget = (f: SheetFile) => f.sheets.find((s) => s.id === 's1')!;

describe('mergeSheetText', () => {
  it('merges edits to different cells', () => {
    const merged = merge(
      (f) => (budget(f).cells.A4 = { v: 'Gas' }),
      (f) => (budget(f).cells.A5 = { v: 'Water' }),
    );
    expect(budget(merged!).cells.A4).toEqual({ v: 'Gas' });
    expect(budget(merged!).cells.A5).toEqual({ v: 'Water' });
    // Both sides changed cells, so the merged inputs equal neither side's: the cached values are
    // marked stale for the next engine run.
    expect(merged!.engine).toBe('');
  });

  it('is a conflict when both sides change the same cell differently', () => {
    expect(
      merge(
        (f) => (budget(f).cells.B2 = { v: 1500 }),
        (f) => (budget(f).cells.B2 = { v: 1600 }),
      ),
    ).toBeNull();
  });

  it('accepts the same change made on both sides', () => {
    const merged = merge(
      (f) => {
        budget(f).cells.B2 = { v: 1500 };
        budget(f).cells.B10.c = 1800;
      },
      (f) => {
        budget(f).cells.B2 = { v: 1500 };
        budget(f).cells.B10.c = 1800;
      },
    );
    expect(budget(merged!).cells.B2).toEqual({ v: 1500 });
  });

  it('returns a side unchanged when only that side changed', () => {
    const mine = serializeSheet(base());
    const theirs = JSON.stringify(JSON.parse(edited((f) => (budget(f).cells.B2 = { v: 1 }))));
    // Their text is not in the stable layout; it comes back exactly as it was.
    expect(mergeSheetText(serializeSheet(base()), mine, theirs)).toBe(theirs);
    expect(mergeSheetText(serializeSheet(base()), theirs, mine)).toBe(theirs);
    expect(mergeSheetText('anything', theirs, theirs)).toBe(theirs);
  });

  it('ignores differing cached values: only content conflicts', () => {
    // Each side changed a different input, so each recalculated B10 to a different value.
    const merged = merge(
      (f) => {
        budget(f).cells.B2 = { v: 1500 };
        budget(f).cells.B10.c = 1800;
      },
      (f) => {
        budget(f).cells.B3 = { v: 400 };
        budget(f).cells.B10.c = 1850;
      },
    );
    expect(budget(merged!).cells.B2).toEqual({ v: 1500 });
    expect(budget(merged!).cells.B3).toEqual({ v: 400 });
    // Neither side computed 1900: the cache is marked stale for the next engine run.
    expect(merged!.engine).toBe('');
    expect(budget(merged!).cells.B10.f).toBe('=SUM(B2:B9)');
  });

  it("takes the cached values of the side whose calculation inputs the merge equals", () => {
    const merged = merge(
      (f) => (budget(f).cols.B = { w: 120 }),
      (f) => {
        budget(f).cells.B2 = { v: 1500 };
        budget(f).cells.B10.c = 1800;
        f.engine = 'hyperformula@9.9.9';
      },
    );
    expect(budget(merged!).cols.B).toEqual({ w: 120 });
    expect(budget(merged!).cells.B10.c).toBe(1800);
    expect(merged!.engine).toBe('hyperformula@9.9.9');
  });

  it('keeps cells that only hold a spilled value when their side is the cache source', () => {
    const merged = merge(
      (f) => (budget(f).frozen = { rows: 2, cols: 0 }),
      (f) => {
        budget(f).cells.D1 = { f: '=SEQUENCE(2)', c: 1 };
        budget(f).cells.D2 = { c: 2 };
      },
    );
    expect(budget(merged!).cells.D2).toEqual({ c: 2 });
    expect(budget(merged!).frozen).toEqual({ rows: 2, cols: 0 });
    expect(merged!.engine).toBe(ENGINE);
  });

  it('deletes a cell one side cleared and the other left alone; conflicts when the other changed it', () => {
    const merged = merge(
      (f) => delete budget(f).cells.A3,
      (f) => (budget(f).cells.A4 = { v: 'x' }),
    );
    expect(budget(merged!).cells.A3).toBeUndefined();
    expect(budget(merged!).cells.A4).toEqual({ v: 'x' });
    expect(
      merge(
        (f) => delete budget(f).cells.A3,
        (f) => (budget(f).cells.A3 = { v: 'Groceries' }),
      ),
    ).toBeNull();
  });

  it('merges column, row and frozen-pane changes per key, and conflicts on the same one', () => {
    const merged = merge(
      (f) => (budget(f).cols.A = { w: 200 }),
      (f) => (budget(f).rows['1'] = { bold: true }),
    );
    expect(budget(merged!).cols.A).toEqual({ w: 200 });
    expect(budget(merged!).rows['1']).toEqual({ bold: true });
    expect(
      merge(
        (f) => (budget(f).cols.A = { w: 200 }),
        (f) => (budget(f).cols.A = { w: 150 }),
      ),
    ).toBeNull();
    expect(
      merge(
        (f) => (budget(f).frozen = { rows: 2, cols: 0 }),
        (f) => (budget(f).frozen = { rows: 0, cols: 1 }),
      ),
    ).toBeNull();
  });

  describe('sheets', () => {
    const add = (f: SheetFile, id: string, name: string, after?: string) => {
      const sheet = { id, name, cells: { A1: { v: name } }, cols: {}, rows: {}, frozen: { rows: 0, cols: 0 }, charts: {} };
      const at = after ? f.sheets.findIndex((s) => s.id === after) + 1 : f.sheets.length;
      f.sheets.splice(at, 0, sheet);
    };

    it('keeps sheets added on both sides, each where it was added', () => {
      const merged = merge(
        (f) => add(f, 'sa', 'Mine', 's1'),
        (f) => add(f, 'sb', 'Theirs'),
      );
      expect(merged!.sheets.map((s) => s.name)).toEqual(['Budget', 'Mine', 'Notes', 'Theirs']);
    });

    it('is a conflict when both sides add a sheet with the same name', () => {
      expect(
        merge(
          (f) => add(f, 'sa', 'Summary'),
          (f) => add(f, 'sb', 'summary'),
        ),
      ).toBeNull();
    });

    it('removes a sheet the other side left alone, and conflicts when the other side edited it', () => {
      const removeNotes = (f: SheetFile) => (f.sheets = f.sheets.filter((s) => s.id !== 's2'));
      const merged = merge(removeNotes, (f) => (budget(f).cells.A4 = { v: 'x' }));
      expect(merged!.sheets.map((s) => s.id)).toEqual(['s1']);
      expect(merge(removeNotes, (f) => (f.sheets[1].cells.A2 = { v: 'more' }))).toBeNull();
      expect(merge((f) => (f.sheets[1].name = 'Journal'), removeNotes)).toBeNull();
    });

    it('merges a rename with cell edits, and conflicts on two different renames', () => {
      const merged = merge(
        (f) => (budget(f).name = 'Costs'),
        (f) => (budget(f).cells.A4 = { v: 'x' }),
      );
      expect(budget(merged!).name).toBe('Costs');
      expect(budget(merged!).cells.A4).toEqual({ v: 'x' });
      expect(
        merge(
          (f) => (budget(f).name = 'Costs'),
          (f) => (budget(f).name = 'Spending'),
        ),
      ).toBeNull();
    });

    it('keeps one side reordering the sheets, and conflicts when both reorder differently', () => {
      const reverse = (f: SheetFile) => f.sheets.reverse();
      const merged = merge(reverse, (f) => add(f, 'sb', 'Theirs', 's1'));
      expect(merged!.sheets.map((s) => s.name)).toEqual(['Notes', 'Budget', 'Theirs']);
      const three = base();
      add(three, 's3', 'Third');
      const reordered = (order: number[]) => serializeSheet({ ...three, sheets: order.map((i) => three.sheets[i]) });
      expect(mergeSheetText(serializeSheet(three), reordered([2, 1, 0]), reordered([1, 2, 0]))).toBeNull();
      expect(mergeSheetText(serializeSheet(three), reordered([2, 0, 1]), reordered([2, 0, 1]))).toBe(reordered([2, 0, 1]));
    });
  });

  it('merges named ranges per name', () => {
    const merged = merge(
      (f) => (f.named.Rent = 'Budget!$B$2'),
      (f) => (f.named.Food = 'Budget!$B$3'),
    );
    expect(merged!.named).toEqual({ Total: 'Budget!$B$10', Rent: 'Budget!$B$2', Food: 'Budget!$B$3' });
    expect(
      merge(
        (f) => (f.named.Total = 'Budget!$B$9'),
        (f) => (f.named.Total = 'Budget!$B$11'),
      ),
    ).toBeNull();
    expect(
      merge(
        (f) => (f.named.rate = '0.1'),
        (f) => (f.named.Rate = '0.2'),
      ),
    ).toBeNull();
  });

  it('merges unknown keys per key', () => {
    const merged = merge(
      (f) => (f.extra = { theme: 'teal' }),
      (f) => (budget(f).cells.A4 = { v: 'x', extra: { s: { bold: true } } }),
    );
    expect(merged!.extra).toEqual({ theme: 'teal' });
    expect(budget(merged!).cells.A4).toEqual({ v: 'x', extra: { s: { bold: true } } });
  });

  it('falls back to the banner when a side cannot be read', () => {
    const good = serializeSheet(base());
    expect(mergeSheetText(good, '{ broken', edited((f) => (budget(f).cells.A9 = { v: 1 })))).toBeNull();
    expect(mergeSheetText('<<<<<<< conflict', edited((f) => (budget(f).cells.A8 = { v: 1 })), edited((f) => (budget(f).cells.A9 = { v: 1 })))).toBeNull();
  });

  it('writes the merge in the stable layout', () => {
    const text = mergeSheetText(
      serializeSheet(base()),
      edited((f) => (budget(f).cells.A4 = { v: 'Gas' })),
      edited((f) => (budget(f).cells.A5 = { v: 'Water' })),
    )!;
    const result = parseSheet(text);
    expect(result.ok && serializeSheet(result.file)).toBe(text);
  });
});

describe('mergeSheetText with formats and charts (6c)', () => {
  it('merges a format set on one side with a value typed on the other, and conflicts on two formats', () => {
    const merged = merge(
      (f) => (budget(f).cells.B2 = { v: 1450, fmt: '$#,##0.00' }),
      (f) => (budget(f).cells.B2 = { v: 1500 }),
    )!;
    expect(budget(merged).cells.B2).toEqual({ v: 1500, fmt: '$#,##0.00' });
    // The calculation inputs are theirs, so their cached values are exact.
    expect(merged.engine).toBe(ENGINE);
    expect(
      merge(
        (f) => (budget(f).cells.B2 = { v: 1450, fmt: '$#,##0.00' }),
        (f) => (budget(f).cells.B2 = { v: 1450, fmt: '0.0' }),
      ),
    ).toBeNull();
    expect(
      merge(
        (f) => (budget(f).cells.B2 = { v: 1, fmt: '0.0' }),
        (f) => (budget(f).cells.B2 = { v: 2 }),
      ),
    ).toBeNull();
  });

  it('merges formats of different cells and keeps the exact cache when only formats changed', () => {
    const merged = merge(
      (f) => (budget(f).cells.B2 = { v: 1450, fmt: '$#,##0.00' }),
      (f) => (budget(f).cells.B10 = { ...budget(f).cells.B10, fmt: '$#,##0' }),
    )!;
    expect(budget(merged).cells.B2).toEqual({ v: 1450, fmt: '$#,##0.00' });
    expect(budget(merged).cells.B10).toEqual({ f: '=SUM(B2:B9)', c: 1750, fmt: '$#,##0' });
    // Formats are not calculation inputs: the cached values stay exact.
    expect(merged.engine).toBe(ENGINE);
  });

  it('merges charts per chart, and conflicts on two different changes of one chart', () => {
    const withChart = (f: SheetFile) => (budget(f).charts.c1 = { type: 'bar', range: 'A1:B3', headers: true, labels: true });
    const merged = merge(
      (f) => {
        withChart(f);
      },
      (f) => (budget(f).charts.c2 = { type: 'pie', range: 'A2:B3', labels: true }),
    )!;
    expect(Object.keys(budget(merged).charts)).toEqual(['c1', 'c2']);
    expect(merged.engine).toBe(ENGINE);

    const text = (edit: (f: SheetFile) => void) => {
      const file = base();
      withChart(file);
      edit(file);
      return serializeSheet(file);
    };
    const chartBase = text(() => {});
    const retitled = text((f) => (budget(f).charts.c1.title = 'Costs'));
    const repied = text((f) => (budget(f).charts.c1.type = 'pie'));
    expect(mergeSheetText(chartBase, retitled, repied)).toBeNull();
    const removed = text((f) => delete budget(f).charts.c1);
    expect(mergeSheetText(chartBase, removed, text((f) => (budget(f).cells.A9 = { v: 'x' })))).toContain('"A9"');
  });
});

describe('keys that are also Object.prototype members', () => {
  it('merges the removal of a named range called constructor into a valid file', () => {
    const named = (n: Record<string, string>) => (f: SheetFile) => (f.named = n);
    const text = (...edits: Array<(f: SheetFile) => void>) => edited((f) => edits.forEach((e) => e(f)));
    const b = text(named({ constructor: 'Budget!$B$2' }));
    const mine = text(named({}));
    const theirs = text(named({ constructor: 'Budget!$B$2' }), (f) => (budget(f).cells.A4 = { v: 'Gas' }));
    const merged = mergeSheetText(b, mine, theirs);
    expect(merged).not.toBeNull();
    const result = parseSheet(merged!);
    expect(result.ok && result.file.named).toEqual({});
    expect(result.ok && budget(result.file).cells.A4).toEqual({ v: 'Gas' });
  });

  it('merges charts and unknown keys named toString or valueOf', () => {
    const b = edited((f) => (budget(f).charts = { toString: { type: 'bar' as const, range: 'A1:B3' } }));
    const mine = edited((f) => (f.extra = { valueOf: 1 }));
    const theirs = edited((f) => (budget(f).charts = { toString: { type: 'bar' as const, range: 'A1:B3' } }));
    const merged = mergeSheetText(b, mine, theirs);
    const result = parseSheet(merged!);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(budget(result.file).charts).toEqual({});
      expect(result.file.extra).toEqual({ valueOf: 1 });
    }
  });
});
