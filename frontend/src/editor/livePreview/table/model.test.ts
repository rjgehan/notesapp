import { markdownLanguage } from '@codemirror/lang-markdown';
import { describe, expect, it } from 'vitest';
import {
  cellContent,
  cellSpans,
  deleteColumn,
  deleteRow,
  displayWidth,
  escapeCell,
  gridRows,
  insertColumn,
  insertRow,
  isSerializationOf,
  moveColumn,
  moveRow,
  newTableText,
  parseTable,
  rowCount,
  serializeTable,
  setAlign,
  setCell,
  unescapeCell,
  type TableModel,
} from './model';

/** Tables as people write them: every one must come back byte for byte. */
const CORPUS: Record<string, string> = {
  simple: '| a | b |\n|---|---|\n| c | d |',
  padded: '| Name  | Age |\n| ----- | --- |\n| Alice | 30  |\n| Bob   | 4   |',
  'no outer pipes': 'a | b\n--|--\nc | d',
  'leading pipes only': '| a | b\n| --- | ---\n| c | d',
  alignment: '| L | C | R | N |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |',
  ragged: '| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |',
  'escaped pipes': String.raw`| a \| b | c |` + '\n|---|---|\n' + String.raw`| ` + '`x \\| y`' + String.raw` | \\\| |`,
  'escaped backslash before a pipe': String.raw`| a\\ | b |` + '\n|---|---|\n' + String.raw`| c\\| d |`,
  'a cell that is only a pipe': String.raw`| \| | b |` + '\n|---|---|\n| c | d |',
  'empty cells': '|  |  |\n|--|--|\n|  | x |\n| | |',
  'trailing whitespace': '| a | b |  \n|---|---|\n| c | d |   \n| e | f',
  indented: '  | a | b |\n  |---|---|\n  | c | d |',
  'row without pipes': '| a | b |\n|---|---|\nfoo\n| c | d |',
  'single column': '| a |\n|---|\n| b |',
  'header only': '| a | b |\n|---|---|',
  unicode: '| 名前 | 😀 |\n| ---- | -- |\n| é | ü |',
  'unicode padded': '| 名前 | Age |\n| ---- | --- |\n| é    | 1   |',
  compact: '|a|b|\n|-|-|\n|c|d|',
  'wikilink alias': String.raw`| [[Note\|alias]] | x |` + '\n|---|---|\n| y | z |',
  'inline formatting': '| **bold** | [link](https://x.com) | `code` |\n|---|---|---|\n| ~~s~~ | ==h== | #tag |',
  'filled delimiter': '|Name |Age|\n|:----|--:|\n|Alice| 30|',
  'right-justified padding': '| Item | Cost |\n| ---- | ---: |\n| Rent | 1450 |\n| Net  |   65 |',
  tabs: '|\ta\t|\tb\t|\n|---|---|\n|c|d|',
  'lone pipe row': '| a |\n|---|\n|',
  'html line break': '| a<br>b | c |\n|---|---|\n| d | e |',
  'pipes inside code': '| `a | b` | c |\n|---|---|---|\n| 1 | 2 | 3 |',
  wide: `|${Array.from({ length: 30 }, (_, i) => ` c${i} `).join('|')}|\n|${Array.from({ length: 30 }, () => '---').join('|')}|\n|${Array.from({ length: 30 }, (_, i) => ` ${i} `).join('|')}|`,
};

function model(text: string): TableModel {
  const m = parseTable(text);
  if (!m) throw new Error(`not a table: ${text}`);
  return m;
}

/** The text of each non-empty cell as Lezer's GFM table parser splits the rows. */
function lezerCells(text: string): string[][] {
  const table = markdownLanguage.parser.parse(text).topNode.firstChild!;
  expect(table.name).toBe('Table');
  const rows: string[][] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name === 'TableDelimiter') continue;
    rows.push(row.getChildren('TableCell').map((c) => text.slice(c.from, c.to)));
  }
  return rows;
}

describe('parse and serialize (ROADMAP 10a)', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`round-trips "${name}" byte for byte`, () => {
      const m = model(text);
      expect(serializeTable(m)).toBe(text);
      expect(isSerializationOf(m, text)).toBe(true);
    });

    it(`splits "${name}" into the cells Lezer finds`, () => {
      const m = model(text);
      const ours = [m.header, ...m.body].map((r) => r.cells.map((c) => c.text).filter((t) => t !== ''));
      expect(ours).toEqual(lezerCells(text));
    });
  }

  it('reads contents, alignment and the column count', () => {
    const m = model(CORPUS.alignment);
    expect(m.columns).toBe(4);
    expect(m.align).toEqual(['left', 'center', 'right', null]);
    expect(gridRows(m)).toEqual([
      ['L', 'C', 'R', 'N'],
      ['1', '2', '3', '4'],
    ]);
  });

  it('unescapes pipes in contents, inside code too', () => {
    const m = model(CORPUS['escaped pipes']);
    expect(gridRows(m)).toEqual([
      ['a | b', 'c'],
      ['`x | y`', String.raw`\\|`],
    ]);
  });

  it('gives short rows empty cells and hides the cells past the header’s', () => {
    expect(gridRows(model(CORPUS.ragged))).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('splits pipes inside code, as GFM does', () => {
    expect(parseTable('| `a | b` |\n|---|')).toBeNull();
    expect(gridRows(model(CORPUS['pipes inside code']))[0]).toEqual(['`a', 'b`', 'c']);
  });

  it('is not a table without a matching delimiter row', () => {
    expect(parseTable('| a | b |\n|---|')).toBeNull();
    // Lezer reads none either (so the editor never shows one as a grid).
    expect(parseTable('| a | b |\n|---|---| \n| c | d |')).toBeNull();
    expect(markdownLanguage.parser.parse('| a | b |\n|---|---| \n| c | d |').topNode.firstChild?.name).toBe('Paragraph');
    expect(parseTable('| a | b |\n| c | d |')).toBeNull();
    expect(parseTable('| a |')).toBeNull();
    expect(parseTable('a\n---')).toBeNull();
    expect(parseTable('| a |\n|---|\n\n| b |')).toBeNull();
  });

  it('detects the style: padded, margin, filled delimiters, justification', () => {
    expect(model(CORPUS.padded).style).toMatchObject({ padded: true, margin: 1, fillDelimiter: false });
    expect(model(CORPUS.simple).style.padded).toBe(true);
    expect(model(CORPUS.alignment).style.padded).toBe(true);
    expect(model(CORPUS['row without pipes']).style.padded).toBe(false);
    expect(model(CORPUS.ragged).style.padded).toBe(false);
    expect(model(CORPUS.compact).style).toMatchObject({ margin: 0, fillDelimiter: true });
    expect(model(CORPUS['filled delimiter']).style).toMatchObject({ padded: true, margin: 0, fillDelimiter: true, justify: ['start', 'end'] });
    expect(model(CORPUS['right-justified padding']).style.justify).toEqual(['start', 'end']);
    expect(model('| a | b |\n|---|---|\n| ccc | d |').style.padded).toBe(false);
  });

  it('measures wide characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('名前')).toBe(4);
    expect(displayWidth('😀')).toBe(2);
    expect(displayWidth('👨‍👩‍👧')).toBe(2);
    expect(displayWidth('é')).toBe(1);
  });

  it('maps every grid cell to its place in the text', () => {
    const text = '| a | b |\n|---|---|\n| c |';
    const spans = cellSpans(model(text));
    expect(spans.map((s) => [s.row, s.column, text.slice(s.from, s.to)])).toEqual([
      [0, 0, ' a '],
      [0, 1, ' b '],
      [1, 0, ' c '],
    ]);
  });
});

describe('escaping', () => {
  it('escapes pipes and leaves already escaped ones', () => {
    expect(escapeCell('a|b')).toBe(String.raw`a\|b`);
    expect(escapeCell(String.raw`a\|b`)).toBe(String.raw`a\|b`);
    expect(escapeCell(String.raw`a\\|b`)).toBe(String.raw`a\\\|b`);
    expect(unescapeCell(escapeCell(String.raw`x\\|y|z`))).toBe(String.raw`x\\|y|z`);
  });
});

/** Applies an edit and checks that its text is what the model says. */
function edited(m: TableModel): string {
  const text = serializeTable(m);
  expect(isSerializationOf(m, text)).toBe(true);
  return text;
}

describe('editing a cell', () => {
  it('rewrites only that row of a compact table, keeping its spacing', () => {
    expect(edited(setCell(model('| a | bb |\n|---|---|\n| c | d |\n| e | f |'), 1, 0, 'cc'))).toBe('| a | bb |\n|---|---|\n| cc | d |\n| e | f |');
    expect(edited(setCell(model('|x |  y|\n|-|-|\n|c|d|'), 0, 1, 'yy'))).toBe('|x |  yy|\n|-|-|\n|c|d|');
    expect(edited(setCell(model('a | b\n--|--\nc | d'), 1, 1, 'dd'))).toBe('a | b\n--|--\nc | dd');
  });

  it('pads the column of a padded table again, as wide as its widest cell', () => {
    const m = model(CORPUS.padded);
    expect(edited(setCell(m, 2, 0, 'Bartholomew'))).toBe('| Name        | Age |\n| ----------- | --- |\n| Alice       | 30  |\n| Bartholomew | 4   |');
    expect(edited(setCell(m, 1, 0, 'Al'))).toBe('| Name | Age |\n| ---- | --- |\n| Al   | 30  |\n| Bob  | 4   |');
    // Pipes that line up are a padded table, however short its cells.
    expect(edited(setCell(model('| a | b |\n|---|---|\n| c | d |\n| e | f |'), 1, 0, 'ccc'))).toBe('| a   | b |\n|-----|---|\n| ccc | d |\n| e   | f |');
    expect(edited(setCell(model(CORPUS['right-justified padding']), 2, 1, '100000'))).toBe(
      '| Item |   Cost |\n| ---- | -----: |\n| Rent |   1450 |\n| Net  | 100000 |',
    );
    expect(edited(setCell(model(CORPUS['filled delimiter']), 1, 0, 'Al'))).toBe('|Name|Age|\n|:---|--:|\n|Al  | 30|');
    expect(edited(setCell(model(CORPUS['unicode padded']), 1, 0, '漢字漢'))).toBe('| 名前   | Age |\n| ------ | --- |\n| 漢字漢 | 1   |');
  });

  it('escapes pipes, and keeps a backslash at the end of a cell from escaping the pipe after it', () => {
    expect(edited(setCell(model(CORPUS.simple), 1, 0, 'x|y'))).toBe('| a    | b |\n|------|---|\n' + String.raw`| x\|y | d |`);
    const compact = model('| a | bb |\n|---|---|\n| c | d |');
    expect(edited(setCell(compact, 1, 0, 'x\\'))).toBe('| a | bb |\n|---|---|\n| x\\ | d |');
    // The space after the backslash is escaped too, so it reads as part of the cell (both show `x\`).
    expect(cellContent(model(edited(setCell(compact, 1, 0, 'x\\'))), 1, 0)).toBe('x\\ ');
    expect(edited(setCell(model('|a|bb|\n|-|-|\n|c|d|'), 1, 0, 'x\\'))).toBe('|a|bb|\n|-|-|\n|x\\ |d|');
    expect(cellContent(model(edited(setCell(compact, 1, 1, 'a | b `c|d`'))), 1, 1)).toBe('a | b `c|d`');
  });

  it('turns newlines into spaces', () => {
    expect(cellContent(model(edited(setCell(model(CORPUS.ragged), 1, 0, 'one\ntwo'))), 1, 0)).toBe('one two');
  });

  it('gives an empty cell the table’s spacing, or the spacing it was given', () => {
    const m = model('| a | bb |\n|---|---|\n|  | d |');
    expect(edited(setCell(m, 1, 0, 'x'))).toBe('| a | bb |\n|---|---|\n| x | d |');
    expect(edited(setCell(m, 1, 0, 'x ', { before: ' ', after: ' ', width: 1 }))).toBe('| a | bb |\n|---|---|\n| x  | d |');
  });

  it('lets the padding after a cell’s text give or take its change in width', () => {
    // Not padded (the last row is short), but the first column lines up.
    const m = model('| Item      | Cost |\n|-----------|------|\n| Rent      | 1450 |\n| Utilities |');
    expect(edited(setCell(m, 1, 0, 'Rental'))).toBe('| Item      | Cost |\n|-----------|------|\n| Rental    | 1450 |\n| Utilities |');
    expect(edited(setCell(m, 1, 0, 'R'))).toBe('| Item      | Cost |\n|-----------|------|\n| R         | 1450 |\n| Utilities |');
    expect(edited(setCell(m, 1, 0, 'Rent for the flat'))).toBe('| Item      | Cost |\n|-----------|------|\n| Rent for the flat | 1450 |\n| Utilities |');
    // The spacing the cell had when its editing began, while you type.
    const pad = { before: ' ', after: '      ', width: 4 };
    expect(edited(setCell(m, 1, 0, 'Rents', pad))).toBe('| Item      | Cost |\n|-----------|------|\n| Rents     | 1450 |\n| Utilities |');
  });

  it('fills a short row up to the cell', () => {
    const text = edited(setCell(model(CORPUS.ragged), 1, 2, 'z'));
    expect(text.split('\n')[2]).toBe('| 1 |  | z |');
    expect(gridRows(model(text))[1]).toEqual(['1', '', 'z']);
  });

  it('keeps every row a row: outer pipes where an edge cell is blank or would start a block', () => {
    const m = model(CORPUS['no outer pipes']);
    expect(edited(setCell(m, 1, 0, ''))).toBe('a | b\n--|--\n| | d');
    expect(edited(setCell(m, 1, 1, ''))).toBe('a | b\n--|--\nc | |');
    expect(edited(setCell(m, 1, 0, '# x'))).toBe('a | b\n--|--\n| # x | d');
    expect(edited(setCell(m, 1, 0, '- x'))).toBe('a | b\n--|--\n| - x | d');
    expect(edited(setCell(m, 1, 0, '1. x'))).toBe('a | b\n--|--\n| 1. x | d');
    expect(edited(setCell(m, 0, 1, ''))).toBe('a | |\n--|--\nc | d');
    const lazy = model(CORPUS['row without pipes']);
    expect(edited(setCell(lazy, 1, 0, ''))).toBe('| a | b |\n|---|---|\n||\n| c | d |');
    expect(edited(setCell(lazy, 1, 0, 'bar'))).toBe('| a | b |\n|---|---|\nbar |\n| c | d |');
    expect(gridRows(model(edited(setCell(lazy, 1, 0, 'bar'))))[1]).toEqual(['bar', '']);
  });

  it('never writes a table that reads differently from its model', () => {
    const m = model(CORPUS.simple);
    const broken: TableModel = { ...m, body: [{ ...m.body[0], cells: [{ before: ' ', text: 'x|y', after: ' ' }, m.body[0].cells[1]] }] };
    expect(isSerializationOf(broken, serializeTable(broken))).toBe(false);
    const heading: TableModel = { ...m, header: { ...m.header, lead: false, cells: [{ before: '', text: '# h', after: ' ' }, m.header.cells[1]] } };
    expect(isSerializationOf(heading, serializeTable(heading))).toBe(false);
  });
});

describe('rows and columns', () => {
  const text = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |';

  it('inserts an empty row in the table’s style', () => {
    expect(edited(insertRow(model(text), 1))).toBe('| a | b |\n| - | - |\n|   |   |\n| 1 | 2 |\n| 3 | 4 |');
    expect(edited(insertRow(model(text), 3))).toBe(`${text}\n|   |   |`);
    expect(edited(insertRow(model('a | bb\n--|--\nc | d'), 2))).toBe('a | bb\n--|--\nc | d\n|  |  |');
    expect(edited(insertRow(model(CORPUS['filled delimiter']), 2))).toBe(`${CORPUS['filled delimiter']}\n|     |   |`);
  });

  it('deletes and moves body rows; the header stays', () => {
    expect(edited(deleteRow(model(text), 1))).toBe('| a | b |\n| - | - |\n| 3 | 4 |');
    expect(deleteRow(model(text), 0)).toEqual(model(text));
    expect(edited(moveRow(model(text), 2, 1))).toBe('| a | b |\n| - | - |\n| 3 | 4 |\n| 1 | 2 |');
    expect(moveRow(model(text), 1, 0)).toEqual(model(text));
  });

  it('inserts an empty column, in compact and padded tables', () => {
    expect(edited(insertColumn(model(text), 1))).toBe('| a |     | b |\n| - | --- | - |\n| 1 |     | 2 |\n| 3 |     | 4 |');
    expect(edited(insertColumn(model(text), 2))).toBe('| a | b |     |\n| - | - | --- |\n| 1 | 2 |     |\n| 3 | 4 |     |');
    expect(edited(insertColumn(model('a | bb\n--|--\nc | d'), 0))).toBe('|  | a | bb\n| --- | --|--\n|  | c | d');
    expect(edited(insertColumn(model('a | bb\n--|--\nc | d'), 2))).toBe('a | bb |  |\n--|-- | --- |\nc | d |  |');
    const ragged = edited(insertColumn(model(CORPUS.ragged), 2));
    expect(gridRows(model(ragged))).toEqual([
      ['a', 'b', '', 'c'],
      ['1', '', '', ''],
      ['1', '2', '', '3'],
    ]);
    expect(ragged.split('\n')[2]).toBe('| 1 |');
  });

  it('deletes a column; a table keeps one', () => {
    expect(edited(deleteColumn(model(text), 0))).toBe('| b |\n| - |\n| 2 |\n| 4 |');
    expect(edited(deleteColumn(model('a | b\n--|--\nc | d'), 1))).toBe('a |\n-- |\nc |');
    expect(deleteColumn(model(CORPUS['single column']), 0)).toEqual(model(CORPUS['single column']));
  });

  it('moves a column with its alignment, filling short rows', () => {
    const m = model('| L | R |\n|:--|--:|\n| 1 | 2 |\n| 3 |');
    const moved = edited(moveColumn(m, 0, 1));
    expect(moved).toBe('| R | L |\n|--:|:--|\n| 2 | 1 |\n|  | 3 |');
    expect(model(moved).align).toEqual(['right', 'left']);
    expect(edited(moveColumn(model('a | bb\n--|:-\nc | d'), 1, 0))).toBe('bb | a\n:-|--\nd | c');
    expect(edited(moveColumn(model(CORPUS.padded), 1, 0))).toBe('| Age | Name  |\n| --- | ----- |\n| 30  | Alice |\n| 4   | Bob   |');
  });

  it('keeps cells past the header’s where they are', () => {
    const m = model(CORPUS.ragged);
    const moved = model(edited(moveColumn(m, 0, 2)));
    expect(moved.body[1].cells.map((c) => c.text)).toEqual(['2', '3', '1', '4', '5']);
    expect(model(edited(deleteColumn(m, 1))).body[1].cells.map((c) => c.text)).toEqual(['1', '3', '4', '5']);
  });

  it('sets alignment markers, keeping the dashes', () => {
    expect(edited(setAlign(model('| a | bb |\n|---|---|\n| c | d |'), 1, 'center'))).toBe('| a | bb |\n|---|:---:|\n| c | d |');
    expect(edited(setAlign(model(CORPUS.alignment), 0, null))).toBe(CORPUS.alignment.replace('|:--|', '|---|'));
    expect(edited(setAlign(model(CORPUS.alignment), 3, 'center'))).toBe(CORPUS.alignment.replace('|---|\n', '|:-:|\n'));
    expect(edited(setAlign(model(CORPUS.padded), 1, 'right'))).toBe('| Name  | Age |\n| ----- | --: |\n| Alice | 30  |\n| Bob   | 4   |');
  });

  it('writes a new empty table that is a padded table', () => {
    const text2 = newTableText(3, 1);
    expect(text2).toBe('|     |     |     |\n| --- | --- | --- |\n|     |     |     |');
    const m = model(text2);
    expect(m.columns).toBe(3);
    expect(m.style.padded).toBe(true);
    expect(edited(setCell(m, 0, 0, 'Name'))).toBe('| Name |     |     |\n| ---- | --- | --- |\n|      |     |     |');
  });
});

describe('random edits never corrupt a table', () => {
  /** A small seeded generator, so a failure can be replayed. */
  function random(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // `§` stands for a backslash.
  const WORDS = ['a', 'Tea', '', ' ', 'x|y', 'a§|b', '§', 'ends§', '`c|d`', '**b**', '[[N§|a]]', '名前', '😀', '# h', '- l', '1. n', '<br>', '  pad  ', 'a\nb', '§§|'].map((w) => w.replaceAll('§', String.fromCharCode(92)));

  /** What a cell holds once written and read back: the editor's text, settled. */
  function settled(content: string): string {
    return unescapeCell(escapeCell(content.replace(/\n/g, ' ')))
      .replace(/^[ \t]+|[ \t]+$/g, '')
      // A cell ending in a backslash is written with a space after it, which reads as part of it.
      .replace(/\\ $/, String.fromCharCode(92));
  }

  function readBack(text: string): string[][] {
    return gridRows(model(text)).map((row) => row.map(settled));
  }

  it('keeps every table readable as exactly the grid it should be', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      const columns = 1 + Math.floor(next() * 4);
      const rows = Math.floor(next() * 4);
      const start = next() < 0.5 ? newTableText(columns, rows) : [`| ${Array.from({ length: columns }, (_, i) => `h${i}`).join(' | ')} |`, `|${'---|'.repeat(columns)}`, ...Array.from({ length: rows }, () => `| ${Array.from({ length: columns }, () => 'v').join(' | ')} |`)].join('\n');
      let m = model(start);
      let expected = gridRows(m).map((row) => row.map(settled));
      for (let step = 0; step < 25; step++) {
        const r = Math.floor(next() * rowCount(m));
        const c = Math.floor(next() * m.columns);
        const op = Math.floor(next() * 8);
        let edit: TableModel;
        if (op <= 2) {
          const content = pick(WORDS) + (next() < 0.3 ? pick(WORDS) : '');
          edit = setCell(m, r, c, content);
          expected[r][c] = settled(content);
        } else if (op === 3) {
          const at = 1 + Math.floor(next() * rowCount(m));
          edit = insertRow(m, at);
          expected.splice(at, 0, Array.from({ length: m.columns }, () => ''));
        } else if (op === 4) {
          edit = deleteRow(m, r);
          if (r >= 1) expected.splice(r, 1);
        } else if (op === 5) {
          const to = 1 + Math.floor(next() * Math.max(1, rowCount(m) - 1));
          edit = moveRow(m, r, to);
          if (r >= 1 && to < rowCount(m) && r !== to) expected.splice(to, 0, expected.splice(r, 1)[0]);
        } else if (op === 6) {
          const kind = Math.floor(next() * 3);
          if (kind === 0) {
            edit = insertColumn(m, c);
            expected = expected.map((row) => [...row.slice(0, c), '', ...row.slice(c)]);
          } else if (kind === 1) {
            edit = deleteColumn(m, c);
            if (m.columns > 1) expected = expected.map((row) => row.filter((_, i) => i !== c));
          } else {
            const to = Math.floor(next() * m.columns);
            edit = moveColumn(m, c, to);
            expected = expected.map((row) => {
              const copy = [...row];
              copy.splice(to, 0, copy.splice(c, 1)[0]);
              return copy;
            });
          }
        } else {
          edit = setAlign(m, c, pick(['left', 'center', 'right', null] as const));
        }
        const text = serializeTable(edit);
        const context = `seed ${seed}, step ${step}, op ${op}:\n${text}`;
        expect(isSerializationOf(edit, text), context).toBe(true);
        expect(readBack(text), context).toEqual(expected);
        m = model(text);
      }
    }
  });
});
