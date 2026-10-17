// Static stand-ins for what a drawing references but the app cannot show live (ROADMAP item 5,
// DESIGN §6.8.1): the Obsidian Excalidraw plugin's extras (a Markdown note or section embedded as an
// image, a LaTeX formula), web images (never fetched) and missing files. Each is an SVG image that
// lives in memory only; the file keeps its reference, so Obsidian still renders the real thing.
//
// The SVGs use the system fonts and the colours of a light canvas: Excalidraw inverts the whole
// canvas in the dark theme, these images included.
import { parseWikiBody } from '../../features/syntax';

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** An SVG document as a base64 data URL (UTF-8). */
export function svgDataUrl(svg: string): string {
  let binary = '';
  for (const b of new TextEncoder().encode(svg)) binary += String.fromCharCode(b);
  return 'data:image/svg+xml;base64,' + btoa(binary);
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

/** A dashed box naming what is not shown: a missing attachment, a web image, an unknown entry. */
export function placeholderDataUrl(label: string, detail: string): string {
  const line = (s: string) => escapeXml(clip(s, 60));
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">` +
      `<rect x="1" y="1" width="318" height="118" rx="8" fill="#f4f4f5" stroke="#a1a1aa" stroke-dasharray="6 4"/>` +
      `<text x="160" y="52" font-family="sans-serif" font-size="15" fill="#3f3f46" text-anchor="middle">${line(label)}</text>` +
      `<text x="160" y="80" font-family="sans-serif" font-size="12" fill="#71717a" text-anchor="middle">${line(detail)}</text>` +
      `</svg>`,
  );
}

// ---------- a note as text ----------

export interface PreviewLine {
  text: string;
  kind: 'heading' | 'text' | 'item' | 'quote' | 'code';
}

function lastSegment(target: string): string {
  return target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** Inline Markdown as the text a reader sees: link labels, no emphasis markers, no block ids. */
export function plainInline(s: string): string {
  return s
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_, body: string) => {
      const { target, subpath, display } = parseWikiBody(body);
      if (display) return display;
      return target === '' ? (subpath ?? '') : subpath ? `${lastSegment(target)} › ${subpath}` : lastSegment(target);
    })
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|\*|_|`)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
}

/**
 * A note's Markdown as lines of plain text (headings, list items, quotes, code), without
 * frontmatter and comments, and with runs of blank lines folded into one.
 */
export function previewLines(markdown: string): PreviewLine[] {
  const text = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines: PreviewLine[] = [];
  let fence: string | null = null;
  const blank = () => {
    if (lines.length > 0 && lines[lines.length - 1].text !== '') lines.push({ text: '', kind: 'text' });
  };
  for (const raw of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (marker && (fence === null || marker[1][0] === fence)) {
      fence = fence === null ? marker[1][0] : null;
      continue;
    }
    if (fence !== null) {
      lines.push({ text: raw.replace(/\t/g, '  '), kind: 'code' });
      continue;
    }
    if (raw.trim() === '' || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      blank();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw);
    if (heading) {
      blank();
      lines.push({ text: plainInline(heading[1]), kind: 'heading' });
      continue;
    }
    const item = /^\s*(?:[-+*]|\d+[.)])\s+(?:\[(.)\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const bullet = item[1] === undefined ? '•' : item[1] === ' ' ? '☐' : '☑';
      lines.push({ text: `${bullet} ${plainInline(item[2])}`, kind: 'item' });
      continue;
    }
    const quote = /^\s*>+\s?(.*)$/.exec(raw);
    if (quote) {
      // A callout's header reads as its title.
      lines.push({ text: plainInline(quote[1].replace(/^\[!(\w+)\][+-]?\s*/, (_, kind: string) => `${kind}: `)), kind: 'quote' });
      continue;
    }
    lines.push({ text: plainInline(raw.trim()), kind: 'text' });
  }
  while (lines.length > 0 && lines[lines.length - 1].text === '') lines.pop();
  return lines;
}

/** Splits a line into lines of at most `width` characters, at spaces where it can. */
export function wrapLine(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = Array.from(text);
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest[0] === ' ') rest.shift();
  }
  if (rest.length > 0 || out.length === 0) out.push(rest.join(''));
  return out;
}

export interface Box {
  width: number;
  height: number;
}

const CARD = { pad: 14, title: 15, size: 13, line: 18, char: 0.56 };

/**
 * A Markdown note embedded in a drawing, as a static card of the element's size: its name and
 * the beginning of its text. The plugin renders the note as an image; Obsidian still does.
 */
export function noteCardSvg(title: string, markdown: string, box?: Box): string {
  const width = Math.max(160, Math.round(box?.width ?? 400));
  const height = Math.max(80, Math.round(box?.height ?? 300));
  const perLine = Math.max(8, Math.floor((width - 2 * CARD.pad) / (CARD.size * CARD.char)));
  const room = Math.max(1, Math.floor((height - 2 * CARD.pad - CARD.title - 10) / CARD.line));
  const lines: PreviewLine[] = [];
  for (const line of previewLines(markdown)) {
    for (const part of line.kind === 'code' ? [clip(line.text, perLine)] : wrapLine(line.text, perLine)) lines.push({ ...line, text: part });
  }
  if (lines.length > room) {
    lines.length = room;
    lines[room - 1] = { ...lines[room - 1], text: clip(lines[room - 1].text, perLine - 1) + '…' };
  }
  const style: Record<PreviewLine['kind'], string> = {
    heading: 'font-weight="600" fill="#18181b"',
    text: 'fill="#3f3f46"',
    item: 'fill="#3f3f46"',
    quote: 'font-style="italic" fill="#52525b"',
    code: 'font-family="ui-monospace, Menlo, Consolas, monospace" fill="#52525b"',
  };
  const top = CARD.pad + CARD.title;
  const body = lines
    .map((l, i) => `<text x="${CARD.pad}" y="${top + 14 + (i + 1) * CARD.line - 4}" ${style[l.kind]}>${escapeXml(l.text)}</text>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${CARD.size}">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d4d4d8"/>` +
    `<text x="${CARD.pad}" y="${top}" font-size="${CARD.title}" font-weight="600" fill="#6d28d9">${escapeXml(clip(title, perLine))}</text>` +
    `<line x1="${CARD.pad}" y1="${top + 8}" x2="${width - CARD.pad}" y2="${top + 8}" stroke="#e4e4e7"/>` +
    body +
    `</svg>`
  );
}

/**
 * A LaTeX formula, as its source in a static box of the element's size. Typesetting would need a
 * math renderer that draws SVG; the plugin uses MathJax for that, and Obsidian still renders it.
 */
export function formulaCardSvg(latex: string, box?: Box): string {
  const width = Math.max(120, Math.round(box?.width ?? 320));
  const height = Math.max(48, Math.round(box?.height ?? 80));
  const size = 14;
  const perLine = Math.max(8, Math.floor((width - 24) / (size * 0.6)));
  const room = Math.max(1, Math.floor((height - 30) / 18));
  let lines = latex
    .trim()
    .split('\n')
    .flatMap((l) => wrapLine(l.trim(), perLine));
  if (lines.length > room) lines = [...lines.slice(0, room - 1), clip(lines[room - 1], perLine - 1) + '…'];
  const first = height / 2 - ((lines.length - 1) * 18) / 2 + 8;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="#fafafa" stroke="#d4d4d8"/>` +
    `<text x="8" y="14" font-family="system-ui, sans-serif" font-size="10" fill="#a1a1aa">LaTeX</text>` +
    lines
      .map(
        (l, i) =>
          `<text x="${width / 2}" y="${first + i * 18}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${size}" fill="#27272a" text-anchor="middle">${escapeXml(l)}</text>`,
      )
      .join('') +
    `</svg>`
  );
}
