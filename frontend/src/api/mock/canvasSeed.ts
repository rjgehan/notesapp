// Demo canvases for the dev mock (ROADMAP item 25): a board that uses every JSON Canvas feature,
// written in Obsidian's layout with fields Obsidian adds, and a generated board with 600 cards for
// trying performance.

const line = (o: object) => '\t\t' + JSON.stringify(o);

function obsidianLayout(nodes: object[], edges: object[], extra = ''): string {
  return ['{', '\t"nodes":[', nodes.map(line).join(',\n'), '\t],', '\t"edges":[', edges.map(line).join(',\n'), '\t]' + (extra ? ',' : ''), ...(extra ? [extra] : []), '}'].join('\n');
}

export const PROJECT_BOARD = obsidianLayout(
  [
    { id: 'a1c0ffee00000001', type: 'group', x: -460, y: -320, width: 1260, height: 760, color: '5', label: 'Alpha launch' },
    {
      id: 'a1c0ffee00000002',
      type: 'text',
      text: '# Alpha launch\n\nShip the **beta** by Friday.\n\n- [x] Spec reviewed\n- [ ] Plan signed off\n\nSee [[Plan B]] and #project/alpha',
      x: -420,
      y: -260,
      width: 360,
      height: 320,
      color: '4',
    },
    { id: 'a1c0ffee00000003', type: 'file', file: 'Projects/Plan.md', x: 0, y: -260, width: 380, height: 420 },
    { id: 'a1c0ffee00000004', type: 'file', file: 'Attachments/diagram.svg', x: 420, y: -260, width: 340, height: 160 },
    { id: 'a1c0ffee00000005', type: 'link', url: 'https://jsoncanvas.org/spec/1.0/', x: 420, y: -40, width: 340, height: 140, color: '6' },
    { id: 'a1c0ffee00000006', type: 'text', text: 'Risks\n1. Scope creep\n2. ==Timeline==', x: -420, y: 140, width: 360, height: 140, color: '1', styleAttributes: {} },
    { id: 'a1c0ffee00000007', type: 'file', file: 'Ideas/Plan B.md', subpath: '#Risks', x: 0, y: 220, width: 380, height: 180 },
    { id: 'a1c0ffee00000008', type: 'text', text: 'Ideas parking lot\n\n- Dark mode for canvases\n- [[Someday ideas]]', x: 900, y: -300, width: 300, height: 200 },
    { id: 'a1c0ffee00000009', type: 'group', x: 880, y: 0, width: 360, height: 240, label: 'Moodboard', background: 'Attachments/diagram.svg', backgroundStyle: 'ratio' },
  ],
  [
    { id: 'e1c0ffee00000001', fromNode: 'a1c0ffee00000002', fromSide: 'right', toNode: 'a1c0ffee00000003', toSide: 'left', label: 'details' },
    { id: 'e1c0ffee00000002', fromNode: 'a1c0ffee00000003', fromSide: 'right', toNode: 'a1c0ffee00000004', toSide: 'left', color: '4' },
    { id: 'e1c0ffee00000003', fromNode: 'a1c0ffee00000006', fromSide: 'top', fromEnd: 'arrow', toNode: 'a1c0ffee00000002', toSide: 'bottom' },
    { id: 'e1c0ffee00000004', fromNode: 'a1c0ffee00000005', fromSide: 'right', toNode: 'a1c0ffee00000008', toSide: 'left', toEnd: 'none', color: '#ff8800', label: 'later' },
    { id: 'e1c0ffee00000005', fromNode: 'a1c0ffee00000003', fromSide: 'bottom', toNode: 'a1c0ffee00000007', toSide: 'top', styleAttributes: { pathfindingMethod: 'square' } },
  ],
  '\t"metadata":{"version":"1.0-1.0","frontmatter":{}}',
);

/** 600 cards in 24 rows, chained left to right, with a group per row block. */
export function bigBoard(): string {
  const nodes: object[] = [];
  const edges: object[] = [];
  const cols = 25;
  const rows = 24;
  const hex = (n: number) => n.toString(16).padStart(16, '0');
  for (let r = 0; r < rows; r += 6) {
    nodes.push({ id: hex(100000 + r), type: 'group', x: -40, y: r * 200 - 60, width: cols * 300 + 40, height: 6 * 200 + 20, label: `Rows ${r + 1}–${r + 6}`, color: String((r / 6) % 6 + 1) });
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const text = i % 10 === 0 ? `## Card ${i + 1}\n\nSome **Markdown** with a link to [[Plan]] and #big/board` : `Card ${i + 1}\n\n${'- item\n'.repeat((i % 3) + 1).trim()}`;
      nodes.push({ id: hex(i + 1), type: 'text', text, x: c * 300, y: r * 200, width: 250, height: 140, ...(i % 7 === 0 ? { color: String((i % 6) + 1) } : {}) });
      if (c > 0) edges.push({ id: hex(500000 + i), fromNode: hex(i), fromSide: 'right', toNode: hex(i + 1), toSide: 'left' });
    }
  }
  return obsidianLayout(nodes, edges);
}

export const CANVAS_NOTE = `# Canvas notes

Boards are \`.canvas\` files in Obsidian's JSON Canvas format. The project board, embedded:

![[Project board.canvas]]

A [[Big board.canvas|big board]] with 600 cards is in \`Canvas/\`.
`;
