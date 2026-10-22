import { describe, expect, it } from 'vitest';
import { blockIdsIn, blockSubpathId, extractBlock, findBlock, linkedBlockId, newBlockId, pickableBlocks, planBlockId, scanBlocks } from './blocks';

const NOTE = [
  '---', // 0
  'tags: [x]', // 1
  '---', // 2
  '# Title ^top', // 3
  '', // 4
  'First paragraph', // 5
  'continues here ^para1', // 6
  '', // 7
  '- item one ^li1', // 8
  '  - nested', // 9
  '- item two', // 10
  '  lazy text', // 11
  '', // 12
  '| a | b |', // 13
  '|---|---|', // 14
  '| 1 | 2 |', // 15
  '', // 16
  '^tbl', // 17
  '', // 18
  '> [!note] Careful', // 19
  '> body', // 20
  '', // 21
  '```js', // 22
  'let x = 1; ^notanid', // 23
  '```', // 24
  '', // 25
  '## Second', // 26
  'Last words', // 27
].join('\n');

describe('scanBlocks', () => {
  const blocks = scanBlocks(NOTE);

  it('finds paragraphs, headings, list items, tables, callouts and code with their lines', () => {
    expect(blocks.map((b) => `${b.kind}:${b.start}-${b.end}`)).toEqual([
      'heading:3-3',
      'paragraph:5-6',
      'list:8-11',
      'list-item:8-9',
      'list-item:9-9',
      'list-item:10-11',
      'table:13-15',
      'callout:19-20',
      'code:22-24',
      'heading:26-26',
      'paragraph:27-27',
    ]);
  });

  it('reads ids at the end of a line and on a line of their own after a block', () => {
    expect(findBlock(blocks, 'top')?.kind).toBe('heading');
    expect(findBlock(blocks, '^PARA1')?.start).toBe(5);
    expect(findBlock(blocks, 'li1')?.text).toBe('item one');
    expect(findBlock(blocks, 'tbl')).toMatchObject({ kind: 'table', idLine: 17 });
    // Ids inside code are not ids.
    expect(findBlock(blocks, 'notanid')).toBeNull();
    expect(blockIdsIn(NOTE)).toContain('notanid'); // the raw line scan (used only to avoid collisions)
  });

  it('gives plain preview text and where a new id goes', () => {
    const para = blocks.find((b) => b.start === 5)!;
    expect(para.text).toBe('First paragraph continues here');
    expect(blocks.find((b) => b.start === 10)).toMatchObject({ placement: 'end', anchor: 11, text: 'item two lazy text', level: 0 });
    expect(blocks.find((b) => b.start === 9)).toMatchObject({ level: 1, anchor: 9 });
    expect(blocks.find((b) => b.kind === 'callout')).toMatchObject({ placement: 'after', anchor: 20, text: 'Careful' });
    expect(blocks.find((b) => b.kind === 'heading' && b.start === 26)).toMatchObject({ level: 2, text: 'Second' });
  });

  it('treats a setext heading as a heading and an id line right after a paragraph as its id', () => {
    const b = scanBlocks('Title\n===\n\nText\n^x1');
    expect(b.map((x) => x.kind)).toEqual(['heading', 'paragraph']);
    expect(b[1]).toMatchObject({ id: 'x1', text: 'Text' });
  });

  it('gives a whole list the id on the line after it, and hides id-less lists from the picker', () => {
    const b = scanBlocks('- a\n- b\n\n^whole\n');
    expect(findBlock(b, 'whole')).toMatchObject({ kind: 'list', start: 0, end: 1 });
    expect(pickableBlocks(scanBlocks('- a\n- b')).map((x) => x.kind)).toEqual(['list-item', 'list-item']);
  });
});

describe('extractBlock', () => {
  it('returns a paragraph, a list item with its children (outdented), a table and a heading section', () => {
    expect(extractBlock(NOTE, 'para1')).toBe('First paragraph\ncontinues here ^para1');
    expect(extractBlock(NOTE, 'li1')).toBe('- item one ^li1\n  - nested');
    expect(extractBlock(NOTE, 'tbl')).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(extractBlock(NOTE, 'top')).toContain('Last words');
    expect(extractBlock('- a\n  - b ^deep\n    - c\n- d', 'deep')).toBe('- b ^deep\n  - c');
    expect(extractBlock(NOTE, 'nope')).toBeNull();
  });
});

describe('blockSubpathId', () => {
  it('reads the id of a block subpath', () => {
    expect(blockSubpathId('^abc')).toBe('abc');
    expect(blockSubpathId('H1#^abc')).toBe('abc');
    expect(blockSubpathId('Heading')).toBeNull();
    expect(blockSubpathId('^')).toBeNull();
    expect(blockSubpathId(null)).toBeNull();
  });
});

describe('planBlockId', () => {
  it('appends to the line, or reuses the id that is already there', () => {
    const text = 'a\nPara text  \nb';
    const plan = planBlockId(text, { line: 1, lineText: 'Para text  ', placement: 'end' }, 'k2k2k2');
    expect(plan).toEqual({ kind: 'insert', id: 'k2k2k2', from: 11, insert: ' ^k2k2k2' });
    expect(planBlockId('x ^old', { line: 0, lineText: 'x ^old', placement: 'end' }, 'new')).toEqual({ kind: 'existing', id: 'old' });
  });

  it('finds the line again when lines moved, and gives up when it is gone or ambiguous', () => {
    expect(planBlockId('new\nfirst\nTarget', { line: 1, lineText: 'Target', placement: 'end' }, 'id')).toMatchObject({ kind: 'insert', from: 16 });
    expect(planBlockId('a\nb', { line: 0, lineText: 'gone', placement: 'end' }, 'id')).toEqual({ kind: 'missing' });
    expect(planBlockId('t\nt\nx', { line: 2, lineText: 't', placement: 'end' }, 'id')).toEqual({ kind: 'missing' });
  });

  it('puts the id of a structured block on a line of its own, in the file’s line endings', () => {
    const text = '| a |\r\n|---|\r\nnext';
    const plan = planBlockId(text, { line: 1, lineText: '|---|', placement: 'after' }, 'tb');
    expect(plan).toEqual({ kind: 'insert', id: 'tb', from: 12, insert: '\r\n\r\n^tb\r\n' });
    expect(planBlockId('| a |\n\n^had', { line: 0, lineText: '| a |', placement: 'after' }, 'x')).toEqual({ kind: 'existing', id: 'had' });
  });
});

describe('newBlockId', () => {
  it('makes 6 lower-case characters that are not taken', () => {
    const seq = [0, 0, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
    let k = 0;
    const id = newBlockId(['AAAAAA'], () => seq[k++ % seq.length]);
    expect(id).toBe('dddddd');
    expect(newBlockId()).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('linkedBlockId', () => {
  it('reads the block a raw link names', () => {
    expect(linkedBlockId('[[Plan#^abc]]')).toBe('abc');
    expect(linkedBlockId('![[Plan#^abc|shown]]')).toBe('abc');
    expect(linkedBlockId('[x](Plan.md#%5Eabc)')).toBe('abc');
    expect(linkedBlockId('[x](<Plan.md#^abc>)')).toBe('abc');
    expect(linkedBlockId('[[Plan#Heading]]')).toBeNull();
    expect(linkedBlockId('[[Plan]]')).toBeNull();
    expect(linkedBlockId('Plan')).toBeNull();
  });
});
