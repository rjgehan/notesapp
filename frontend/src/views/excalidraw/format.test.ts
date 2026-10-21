import { describe, expect, it } from 'vitest';
import { el, lzBomb, markdownDrawing, PLUGIN_HEAD, scene, text } from '../../test/drawings';
import {
  compressDrawing,
  decompressDrawing,
  drawingFormat,
  isMarkdownTextId,
  markdownParts,
  markdownRest,
  newDrawingContent,
  parseDrawing,
  parseEmbeddedValue,
  parseTextEntries,
  renameElementIds,
  shortId,
  writeDrawing,
  type Drawing,
  type Scene,
} from './format';

function parsed(format: 'excalidraw' | 'markdown', text: string): Drawing {
  const r = parseDrawing(format, text);
  if (!r.ok) throw new Error(r.message);
  return r.drawing;
}

describe('drawing formats', () => {
  it('tells the formats apart by name', () => {
    expect(drawingFormat('Diagrams/Plan.excalidraw')).toBe('excalidraw');
    expect(drawingFormat('Diagrams/Plan.excalidraw.md')).toBe('markdown');
    expect(drawingFormat('Diagrams/Plan.Excalidraw.MD')).toBe('markdown');
  });

  it('a new drawing is an empty excalidraw.com scene', () => {
    const d = parsed('excalidraw', newDrawingContent());
    expect(d.scene.type).toBe('excalidraw');
    expect(d.scene.elements).toEqual([]);
    expect(d.scene.files).toEqual({});
  });
});

describe('.excalidraw (plain JSON)', () => {
  it('reads an excalidraw.com file and keeps unknown fields', () => {
    const s = scene([el('a', { customData: { x: 1 } })], { source: 'https://excalidraw.com', extra: true } as Partial<Scene>);
    const d = parsed('excalidraw', JSON.stringify(s, null, 2));
    expect(d.scene.elements[0]).toMatchObject({ id: 'a', customData: { x: 1 } });
    expect(d.scene.extra).toBe(true);
    expect(writeDrawing(d, d.scene)).toBe(JSON.stringify(s, null, 2));
  });

  it('treats an empty file as an empty drawing', () => {
    expect(parsed('excalidraw', '').scene.elements).toEqual([]);
    expect(parsed('excalidraw', '  \n').scene.elements).toEqual([]);
  });

  it('reports malformed files instead of guessing', () => {
    expect(parseDrawing('excalidraw', '{"elements": [')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseDrawing('excalidraw', '{"type": "excalidrawlib", "elements": []}')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseDrawing('excalidraw', '{"elements": [{"type": "rectangle"}]}')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(parseDrawing('excalidraw', '[1, 2]')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('.excalidraw.md (Obsidian Excalidraw)', () => {
  const base = scene([text('Ab12Cd34', 'Hello World'), text('Xy98Zw76', 'Second line\ncontinues'), el('rect0001')]);
  const file = markdownDrawing({
    texts: [
      ['Ab12Cd34', 'Hello [[World]]'],
      ['Xy98Zw76', 'Second line\ncontinues'],
    ],
    embedded: [['5d2f9c0e7b1a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', '[[Pasted Image 20240101120000.png]]']],
    scene: base,
    tail: '\n',
  });

  it('reads the json drawing block, the text elements and the embedded files', () => {
    const d = parsed('markdown', file);
    expect(d.scene.elements.map((e) => e.id)).toEqual(['Ab12Cd34', 'Xy98Zw76', 'rect0001']);
    expect(d.markdown!.texts).toEqual([
      { id: 'Ab12Cd34', raw: 'Hello [[World]]' },
      { id: 'Xy98Zw76', raw: 'Second line\ncontinues' },
    ]);
    expect(d.markdown!.embedded).toEqual([
      { id: '5d2f9c0e7b1a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', value: '[[Pasted Image 20240101120000.png]]', ref: { kind: 'link', target: 'Pasted Image 20240101120000.png' } },
    ]);
  });

  it('reads compressed-json blocks, with the plugin’s line breaks', () => {
    const compressed = markdownDrawing({ texts: [['Ab12Cd34', 'Hello']], scene: base, compressed: true });
    expect(compressed).toContain('```compressed-json\n');
    expect(parsed('markdown', compressed).scene.elements).toHaveLength(3);
  });

  it('writes nothing but the drawing block when only shapes moved', () => {
    const d = parsed('markdown', file);
    const moved = { ...d.scene, elements: d.scene.elements.map((e) => (e.id === 'rect0001' ? { ...e, x: 50, version: 2 } : e)) };
    const out = writeDrawing(d, moved, { rawText: (e) => d.markdown!.texts.find((t) => t.id === e.id)?.raw });
    const before = markdownParts(file);
    const after = markdownParts(out);
    expect(markdownRest(after)).toBe(markdownRest(before));
    expect(out.slice(after.textSection!.from, after.textSection!.to)).toBe(file.slice(before.textSection!.from, before.textSection!.to));
    expect(out.slice(after.embeddedSection!.from, after.embeddedSection!.to)).toBe(file.slice(before.embeddedSection!.from, before.embeddedSection!.to));
    expect(parsed('markdown', out).scene.elements.find((e) => e.id === 'rect0001')).toMatchObject({ x: 50 });
    // The plugin's indentation, and its rawText next to the text.
    expect(out).toContain('{\n\t"type": "excalidraw"');
    expect(parsed('markdown', out).scene.elements[0]).toMatchObject({ rawText: 'Hello [[World]]' });
  });

  it('keeps a compressed block compressed', () => {
    const compressed = markdownDrawing({ texts: [['Ab12Cd34', 'Hello World']], scene: base, compressed: true });
    const d = parsed('markdown', compressed);
    const out = writeDrawing(d, { ...d.scene, elements: [...d.scene.elements, el('new00001')] });
    expect(out).toMatch(/```compressed-json\n[A-Za-z0-9+/=\n]+\n```\n%%$/);
    expect(parsed('markdown', out).scene.elements.map((e) => e.id)).toContain('new00001');
  });

  it('rewrites the Text Elements section from the text elements, keeping their order', () => {
    const d = parsed('markdown', file);
    const [, second, rect] = d.scene.elements;
    // The first text is deleted, the second edited, a third added.
    const elements = [rect, { ...second, originalText: 'Edited', text: 'Edited' }, text('New12345', 'Fresh')];
    const out = writeDrawing(d, { ...d.scene, elements });
    const parts = markdownParts(out);
    expect(parts.texts).toEqual([
      { id: 'Xy98Zw76', raw: 'Edited' },
      { id: 'New12345', raw: 'Fresh' },
    ]);
    expect(out.slice(parts.textSection!.from, parts.textSection!.to)).toBe('Edited ^Xy98Zw76\n\nFresh ^New12345\n\n');
    expect(markdownRest(parts)).toBe(markdownRest(markdownParts(file)));
  });

  it('lists new attachments under Embedded Files, creating the section when needed', () => {
    const d = parsed('markdown', file);
    const out = writeDrawing(d, d.scene, { rawText: (e) => d.markdown!.texts.find((t) => t.id === e.id)?.raw, addEmbedded: [{ id: 'abc', value: '[[photo.jpg]]' }] });
    expect(markdownParts(out).embedded.map((e) => e.id)).toEqual(['5d2f9c0e7b1a4c3d2e1f0a9b8c7d6e5f4a3b2c1d', 'abc']);
    // Entries already listed are not repeated.
    expect(writeDrawing(parsed('markdown', out), d.scene, { addEmbedded: [{ id: 'abc', value: '[[photo.jpg]]' }] }).match(/abc: /g)).toHaveLength(1);

    const plain = markdownDrawing({ texts: [['Ab12Cd34', 'Hello World']], scene: scene([text('Ab12Cd34', 'Hello World')]) });
    const added = writeDrawing(parsed('markdown', plain), parsed('markdown', plain).scene, { addEmbedded: [{ id: 'abc', value: '[[photo.jpg]]' }] });
    expect(added).toContain('Hello World ^Ab12Cd34\n\n## Embedded Files\nabc: [[photo.jpg]]\n\n%%\n## Drawing\n```json\n');
    expect(parsed('markdown', added).markdown!.embedded[0]).toMatchObject({ id: 'abc', ref: { kind: 'link', target: 'photo.jpg' } });
  });

  it('keeps everything around the managed parts byte for byte', () => {
    const custom = markdownDrawing({
      head: '---\nexcalidraw-plugin: parsed\ntags: [excalidraw, plan]\ncssclasses: wide\n---\nNotes **before** the drawing.\r\n\n# Excalidraw Data\n\n',
      texts: [['Ab12Cd34', 'Hello World']],
      scene: scene([text('Ab12Cd34', 'Hello World')]),
      tail: '\n\nTrailing notes after the comment.\n',
    }).replace('## Text Elements\n', '## Text Elements\n');
    const d = parsed('markdown', custom);
    const out = writeDrawing(d, { ...d.scene, elements: [...d.scene.elements, el('new00001')] });
    expect(out.startsWith('---\nexcalidraw-plugin: parsed\ntags: [excalidraw, plan]\ncssclasses: wide\n---\nNotes **before** the drawing.\r\n\n# Excalidraw Data\n\n## Text Elements\nHello World ^Ab12Cd34\n\n%%\n## Drawing\n```json\n')).toBe(true);
    expect(out.endsWith('\n```\n%%\n\nTrailing notes after the comment.\n')).toBe(true);
  });

  it('reads the older plugin layout (# Text Elements, # Drawing)', () => {
    const old = `---\n\nexcalidraw-plugin: parsed\n\n---\n\n# Text Elements\nOld text ^oldtxt01\n\n%%\n# Drawing\n\`\`\`json\n${JSON.stringify(scene([text('oldtxt01', 'Old text')]))}\n\`\`\`\n%%`;
    const d = parsed('markdown', old);
    expect(d.markdown!.texts).toEqual([{ id: 'oldtxt01', raw: 'Old text' }]);
    expect(d.scene.elements[0].id).toBe('oldtxt01');
  });

  it('a plugin file without a drawing yet is an empty drawing, and gets its data part appended', () => {
    const empty = '---\nexcalidraw-plugin: parsed\n---\nJust a stub.\n';
    const d = parsed('markdown', empty);
    expect(d.scene.elements).toEqual([]);
    const out = writeDrawing(d, { ...d.scene, elements: [text('Ab12Cd34', 'First')] });
    expect(out.startsWith(empty)).toBe(true);
    const again = parsed('markdown', out);
    expect(again.scene.elements.map((e) => e.id)).toEqual(['Ab12Cd34']);
    expect(again.markdown!.texts).toEqual([{ id: 'Ab12Cd34', raw: 'First' }]);
  });

  it('a Markdown note without a drawing is not a drawing', () => {
    expect(parseDrawing('markdown', '# Just a note\n\nNamed like a drawing.')).toMatchObject({ ok: false, reason: 'not-a-drawing' });
  });

  it('a damaged drawing block is reported, never replaced', () => {
    const broken = markdownDrawing({ scene: scene([]) }).replace('"type": "excalidraw"', '"type": "excalidraw",,');
    expect(parseDrawing('markdown', broken)).toMatchObject({ ok: false, reason: 'malformed' });
    const badCompression = `${PLUGIN_HEAD}%%\n## Drawing\n\`\`\`compressed-json\n!!!not base64!!!\n\`\`\`\n%%`;
    expect(parseDrawing('markdown', badCompression)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('finds the drawing block in linear time, also in a crafted file of unclosed fences', () => {
    const crafted = '---\nexcalidraw-plugin: parsed\n---\n' + '## Drawing\n```json\n'.repeat(40_000);
    const started = performance.now();
    expect(markdownParts(crafted).drawing).toBeNull();
    expect(parseDrawing('markdown', crafted)).toMatchObject({ ok: true });
    expect(performance.now() - started).toBeLessThan(2000);
    // The nearest closing fence after the last heading still closes it.
    const closed = crafted + '```\n';
    expect(markdownParts(closed).drawing).toMatchObject({ encoding: 'json', range: { from: closed.length - 4, to: closed.length - 4 } });
  });

  it('reads crafted sections and texts in linear time too', () => {
    const spaces = ' '.repeat(100_000);
    const crafted = [
      markdownDrawing({ links: [['Ab12Cd34', `${spaces}[[x]]${spaces}`], ['Ef56Gh78', `a${spaces}b`]], scene: scene([]) }),
      markdownDrawing({ texts: [['Ab12Cd34', '[['.repeat(30_000) + '[a](b'.repeat(30_000) + '[[a|'.repeat(30_000)]], scene: scene([text('Ab12Cd34', 'x', { rawText: 'y', link: '[[y]]' })]) }),
      '---\n' + 'excalidraw-plugin? no\n'.repeat(100_000),
    ];
    const started = performance.now();
    expect(parsed('markdown', crafted[0]).markdown!.links).toEqual([
      { id: 'Ab12Cd34', link: '[[x]]' },
      { id: 'Ef56Gh78', link: `a${spaces}b` },
    ]);
    expect(parsed('markdown', crafted[1]).scene.elements[0]).toMatchObject({ link: '[[y]]' });
    expect(parseDrawing('markdown', crafted[2])).toMatchObject({ ok: false, reason: 'not-a-drawing' });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('takes a text’s source from the section when a rename rewrote it there, with the link and the text shown', () => {
    const renamed = markdownDrawing({
      texts: [
        ['Ab12Cd34', 'See [[Plumber Bob]]'],
        ['Cc33Dd44', 'Call [[Plumber Bob|him]]'],
        ['Ee55Ff66', 'Boxed [[Plumber Bob]]'],
      ],
      scene: scene([
        text('Ab12Cd34', 'See Plumber', { rawText: 'See [[Plumber]]', link: '[[Plumber]]' }),
        text('Cc33Dd44', 'Call him', { rawText: 'Call [[Plumber|him]]', link: '[[Plumber]]' }),
        text('Ee55Ff66', 'Boxed\nPlumber', { originalText: 'Boxed Plumber', rawText: 'Boxed [[Plumber]]', link: '[[Plumber]]', containerId: 'box' }),
      ]),
    });
    const [see, call, boxed] = parsed('markdown', renamed).scene.elements;
    expect(see).toMatchObject({ rawText: 'See [[Plumber Bob]]', link: '[[Plumber Bob]]', text: 'See Plumber Bob', originalText: 'See Plumber Bob' });
    expect(call).toMatchObject({ rawText: 'Call [[Plumber Bob|him]]', link: '[[Plumber Bob]]', text: 'Call him', originalText: 'Call him' });
    // A wrapped text keeps its lines until it is next edited.
    expect(boxed).toMatchObject({ link: '[[Plumber Bob]]', text: 'Boxed\nPlumber', originalText: 'Boxed Plumber Bob' });
    // The plugin's raw mode shows the source itself.
    const raw = renamed.replace('excalidraw-plugin: parsed', 'excalidraw-plugin: raw');
    expect(parsed('markdown', raw).scene.elements[0]).toMatchObject({ text: 'See [[Plumber Bob]]', link: '[[Plumber Bob]]' });
    // A link set by hand on the element is not the text's to change.
    const own = renamed.replace('"link": "[[Plumber]]"', '"link": "https://example.com"');
    expect(parsed('markdown', own).scene.elements[0].link).toBe('https://example.com');
  });

  it('parses text entries like the plugin, with multi-line texts', () => {
    expect(parseTextEntries('One ^aaaaaaaa\n\nTwo\nlines ^bbbbbbbb\n\nLast ^cccccccc')).toEqual([
      { id: 'aaaaaaaa', raw: 'One' },
      { id: 'bbbbbbbb', raw: 'Two\nlines' },
      { id: 'cccccccc', raw: 'Last' },
    ]);
  });

  it('classifies embedded file values', () => {
    expect(parseEmbeddedValue('[[Folder/pic.png|100]]')).toEqual({ kind: 'link', target: 'Folder/pic.png' });
    expect(parseEmbeddedValue('[[Notes/Plan#Costs]]')).toEqual({ kind: 'link', target: 'Notes/Plan', subpath: 'Costs' });
    expect(parseEmbeddedValue('[[pic.png]] {"#000":"#fff"}')).toEqual({ kind: 'link', target: 'pic.png' });
    expect(parseEmbeddedValue('$$e=mc^2$$')).toEqual({ kind: 'latex', latex: 'e=mc^2' });
    expect(parseEmbeddedValue('https://example.com/a.png')).toEqual({ kind: 'url', url: 'https://example.com/a.png' });
    expect(parseEmbeddedValue('something else')).toEqual({ kind: 'other' });
  });
});

describe('Element Links (Obsidian Excalidraw)', () => {
  const linked = scene([
    text('Ab12Cd34', 'Hello', { link: '[[Old]]' }),
    el('Rr11Ss22', { link: '[[Shape]]' }),
    el('long-id-0123456789abcd', { link: '[[Json only]]' }),
    text('Tt33Uu44', 'See Synced', { link: '[[Synced]]' }),
  ]);
  const file = markdownDrawing({
    texts: [
      ['Ab12Cd34', 'Hello'],
      ['Tt33Uu44', 'See [[Synced]]'],
    ],
    links: [
      ['Ab12Cd34', '[[Renamed]]'],
      ['Rr11Ss22', '[[Shape]]'],
    ],
    scene: linked,
  });
  const raw = (d: Drawing) => (e: { id: string }) => d.markdown!.texts.find((t) => t.id === e.id)?.raw;

  it('takes links from the section over the JSON, as the plugin does', () => {
    const d = parsed('markdown', file);
    expect(d.markdown!.links).toEqual([
      { id: 'Ab12Cd34', link: '[[Renamed]]' },
      { id: 'Rr11Ss22', link: '[[Shape]]' },
    ]);
    expect(d.scene.elements.map((e) => e.link)).toEqual(['[[Renamed]]', '[[Shape]]', '[[Json only]]', '[[Synced]]']);
    // The texts stop at the section, which is not a text entry.
    expect(d.markdown!.texts.map((t) => t.id)).toEqual(['Ab12Cd34', 'Tt33Uu44']);
  });

  it('leaves the section as it is while no link changed', () => {
    const d = parsed('markdown', file);
    const moved = { ...d.scene, elements: d.scene.elements.map((e) => (e.id === 'Rr11Ss22' ? { ...e, x: 40, version: 9 } : e)) };
    const out = writeDrawing(d, moved, { rawText: raw(d) });
    const before = markdownParts(file);
    const after = markdownParts(out);
    expect(out.slice(after.linkSection!.from, after.linkSection!.to)).toBe(file.slice(before.linkSection!.from, before.linkSection!.to));
    expect(markdownRest(after)).toBe(markdownRest(before));
    // The JSON now carries the section's link.
    expect(parsed('markdown', out).scene.elements[0].link).toBe('[[Renamed]]');
  });

  it('updates, drops and adds entries as links change, and leaves other links in the JSON', () => {
    const d = parsed('markdown', file);
    const [hello, shape, long, synced] = d.scene.elements;
    const elements = [
      { ...hello, link: null },
      { ...shape, link: '[[New shape]]' },
      { ...long, link: '[[Still json]]' },
      synced,
      text('New12345', 'Fresh', { link: 'Folder/Fresh.md' }),
    ];
    const out = writeDrawing(d, { ...d.scene, elements }, { rawText: raw(d) });
    const parts = markdownParts(out);
    expect(out.slice(parts.linkSection!.from, parts.linkSection!.to)).toBe('Rr11Ss22: [[New shape]]\n\nNew12345: Folder/Fresh.md\n\n');
    expect(parsed('markdown', out).scene.elements.map((e) => e.link ?? null)).toEqual([null, '[[New shape]]', '[[Still json]]', '[[Synced]]', 'Folder/Fresh.md']);
  });

  it('creates the section after the text elements for the first link', () => {
    const plain = markdownDrawing({ texts: [['Ab12Cd34', 'Hello']], scene: scene([text('Ab12Cd34', 'Hello')]) });
    const d = parsed('markdown', plain);
    const out = writeDrawing(d, { ...d.scene, elements: [{ ...d.scene.elements[0], link: '[[Target]]' }] });
    expect(out).toContain('## Text Elements\nHello ^Ab12Cd34\n\n## Element Links\nAb12Cd34: [[Target]]\n\n%%\n## Drawing\n');
    const again = parsed('markdown', out);
    expect(again.markdown!.texts).toEqual([{ id: 'Ab12Cd34', raw: 'Hello' }]);
    expect(again.markdown!.links).toEqual([{ id: 'Ab12Cd34', link: '[[Target]]' }]);
    // A link on a shape with Excalidraw's long id stays in the JSON; the plugin lists it when it next saves.
    const shape = writeDrawing(d, { ...d.scene, elements: [...d.scene.elements, el('long-id-0123456789abcd', { link: '[[X]]' })] });
    expect(markdownParts(shape).linkSection).toBeNull();
  });
});

describe('LZ-String blocks', () => {
  it('compresses in 256-character chunks and decompresses across line breaks', () => {
    const json = JSON.stringify(scene(Array.from({ length: 50 }, (_, i) => el(`id${i}`, { x: i * 13.37 }))), null, '\t');
    const block = compressDrawing(json);
    const lines = block.split('\n\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((l) => l.length === 256)).toBe(true);
    expect(decompressDrawing(block)).toBe(json);
    expect(decompressDrawing(block.replace(/\n/g, '\r\n'))).toBe(json);
    expect(decompressDrawing('')).toBeNull();
  });

  it('reports a block that would decompress past the bound as unreadable, without decompressing it', () => {
    // About 13 KB of crafted codes that would expand to 18 million characters.
    const huge = lzBomb(6000);
    expect(decompressDrawing(huge)).toBeNull();
    const file = `${PLUGIN_HEAD}%%\n## Drawing\n\`\`\`compressed-json\n${huge}\n\`\`\`\n%%`;
    expect(parseDrawing('markdown', file)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('text element ids in Markdown drawings', () => {
  it('derives stable 8-character ids that Obsidian block references accept', () => {
    const a = shortId('Kx3yG7mZ-wq_9pLrT2vNc', new Set());
    expect(a).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(shortId('Kx3yG7mZ-wq_9pLrT2vNc', new Set())).toBe(a);
    expect(shortId('Kx3yG7mZ-wq_9pLrT2vNc', new Set([a]))).not.toBe(a);
    expect(isMarkdownTextId('Ab12Cd34')).toBe(true);
    expect(isMarkdownTextId('Kx3yG7mZ-wq_9pLrT2vNc')).toBe(false);
  });

  it('renames ids and every reference to them', () => {
    const elements = [
      el('box', { boundElements: [{ id: 'longTextId', type: 'text' }, { id: 'arrow', type: 'arrow' }] }),
      text('longTextId', 'Label', { containerId: 'box' }),
      el('arrow', { type: 'arrow', startBinding: { elementId: 'longTextId', focus: 0, gap: 1 }, endBinding: { elementId: 'box', focus: 0, gap: 1 } }),
      el('framed', { frameId: 'longTextId' }),
    ];
    const out = renameElementIds(elements, new Map([['longTextId', 'Sh0rtId1']]));
    expect(out[0].boundElements).toEqual([{ id: 'Sh0rtId1', type: 'text' }, { id: 'arrow', type: 'arrow' }]);
    expect(out[1]).toMatchObject({ id: 'Sh0rtId1', containerId: 'box' });
    expect(out[2]).toMatchObject({ startBinding: { elementId: 'Sh0rtId1' }, endBinding: { elementId: 'box' } });
    expect(out[3].frameId).toBe('Sh0rtId1');
    // Untouched elements are the same objects; the input is not mutated.
    expect(renameElementIds(elements, new Map([['zzz', 'y']]))[0]).toBe(elements[0]);
    expect(elements[1].id).toBe('longTextId');
  });
});
