// The mock's port of the server's CanvasIndexer (ROADMAP item 25): a canvas's searchable text has
// one block per item (card Markdown, group name, link address, file path, edge label) separated
// by blank lines; each card is scanned on its own, and every file node links to its file.
import { lineStartsOf, scanNote, type NoteScan, type ScannedLink, type ScannedTag } from './scan';

export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith('.canvas');
}

interface Block {
  text: string;
  markdown: boolean;
  file?: string;
  subpath?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function scanCanvas(content: string): { text: string; scan: NoteScan } {
  const blocks: Block[] = [];
  const markdown = (t: string | null) => {
    if (t && t.trim() !== '') blocks.push({ text: t.replace(/\r\n?/g, '\n'), markdown: true });
  };
  try {
    const data = content.trim() === '' ? {} : (JSON.parse(content) as Record<string, unknown>);
    for (const n of Array.isArray(data.nodes) ? data.nodes : []) {
      if (typeof n !== 'object' || n === null) continue;
      const node = n as Record<string, unknown>;
      if (node.type === 'text') markdown(str(node.text));
      else if (node.type === 'group') markdown(str(node.label));
      else if (node.type === 'link') markdown(str(node.url));
      else if (node.type === 'file') {
        const file = str(node.file);
        if (file && file.trim() !== '') {
          const subpath = str(node.subpath) ?? '';
          blocks.push({ text: file + subpath, markdown: false, file, subpath });
        }
      }
    }
    for (const e of Array.isArray(data.edges) ? data.edges : []) {
      if (typeof e === 'object' && e !== null) markdown(str((e as Record<string, unknown>).label));
    }
  } catch {
    // Not a canvas: listed by name only.
  }
  let text = '';
  let line = 0;
  const links: ScannedLink[] = [];
  const tagOccurrences: ScannedTag[] = [];
  const headings: NoteScan['headings'] = [];
  const blockIds: string[] = [];
  const excluded: Array<[number, number]> = [];
  for (const b of blocks) {
    if (text !== '') {
      text += '\n\n';
      line += 2;
    }
    const start = text.length;
    text += b.text;
    if (b.markdown) {
      // The leading newline keeps a card starting with "---" from reading as frontmatter.
      const scan = scanNote('\n' + b.text);
      const offset = start - 1;
      const lines = line - 1;
      for (const l of scan.links) {
        links.push({ ...l, line: l.line + lines, from: l.from + offset, to: l.to + offset, targetFrom: l.targetFrom, targetTo: l.targetTo, inFrontmatter: false });
      }
      for (const t of scan.tagOccurrences) tagOccurrences.push({ ...t, line: t.line + lines, from: t.from + offset, to: t.to + offset });
      for (const h of scan.headings) headings.push({ ...h, line: h.line + lines });
      blockIds.push(...scan.blockIds);
      for (const [a, z] of scan.excluded) excluded.push([a + offset, z + offset]);
    } else if (b.file) {
      const sub = b.subpath?.replace(/^#/, '') ?? '';
      links.push({
        raw: b.text,
        target: b.file,
        subpath: sub === '' ? null : sub,
        display: null,
        embed: true,
        style: 'wiki',
        line,
        from: start,
        to: text.length,
        targetFrom: 0,
        targetTo: b.file.length,
        angle: false,
        inFrontmatter: false,
      });
    }
    line += b.text.split('\n').length - 1;
  }
  const seen = new Map<string, string>();
  for (const t of tagOccurrences) if (!seen.has(t.tag.toLowerCase())) seen.set(t.tag.toLowerCase(), t.tag);
  return {
    text,
    scan: {
      frontmatter: null,
      frontmatterError: null,
      bodyStart: 0,
      aliases: [],
      tags: [...seen.values()],
      tagOccurrences,
      headings,
      links,
      blockIds,
      excluded,
      lineStarts: lineStartsOf(text),
    },
  };
}
