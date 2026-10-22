// The formatting toolbar over selected text in Live Preview (DESIGN §6.6.1, ROADMAP 10a), desktop
// only (phones have the keyboard toolbar and the system's own selection menu): bold, italic,
// strikethrough, highlight, code, link and a heading menu. A CodeMirror tooltip above the
// selection, shown once the mouse button is up; its buttons never take the focus, so the selection
// stays and the commands act on it.
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, ViewPlugin, type Tooltip, type TooltipView, type ViewUpdate } from '@codemirror/view';
import { keyLabel } from '../../features/platform';
import { noteContext } from '../context';
import { hasFormat, inLink, setHeading, toggleBold, toggleHighlight, toggleInlineCode, toggleItalic, toggleLink, toggleStrikethrough, type InlineFormat } from '../formatting';
import { isTableCell } from './table/facets';

/** Lucide icons (ISC), drawn without React: [element, attributes] pairs on a 24×24 grid. */
type IconNode = Array<[string, Record<string, string>]>;

const ICONS: Record<string, IconNode> = {
  bold: [['path', { d: 'M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8' }]],
  italic: [
    ['line', { x1: '19', x2: '10', y1: '4', y2: '4' }],
    ['line', { x1: '14', x2: '5', y1: '20', y2: '20' }],
    ['line', { x1: '15', x2: '9', y1: '4', y2: '20' }],
  ],
  strikethrough: [
    ['path', { d: 'M16 4H9a3 3 0 0 0-2.83 4' }],
    ['path', { d: 'M14 12a4 4 0 0 1 0 8H6' }],
    ['line', { x1: '4', x2: '20', y1: '12', y2: '12' }],
  ],
  highlight: [
    ['path', { d: 'm9 11-6 6v3h9l3-3' }],
    ['path', { d: 'm22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4' }],
  ],
  code: [
    ['path', { d: 'm16 18 6-6-6-6' }],
    ['path', { d: 'm8 6-6 6 6 6' }],
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
  ],
  heading: [
    ['path', { d: 'M6 12h12' }],
    ['path', { d: 'M6 20V4' }],
    ['path', { d: 'M18 20V4' }],
  ],
};

function icon(name: string): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name]) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

interface Tool {
  id: string;
  label: string;
  key?: string;
  format?: InlineFormat;
  /** Changes whole lines: not in a table cell. */
  lines?: boolean;
  run(view: EditorView, button: HTMLElement): unknown;
}

/** The heading menu: plain text or a heading level, for the selected lines. */
function headingMenu(view: EditorView, button: HTMLElement): void {
  const ctx = view.state.facet(noteContext);
  if (!ctx) return;
  const rect = button.getBoundingClientRect();
  const levels = [1, 2, 3, 4, 5, 6].map((level) => ({ id: `h${level}`, label: `Heading ${level}`, run: () => setHeading(view, level) }));
  ctx.showMenu({ x: rect.left, y: rect.bottom + 4 }, 'Heading', [{ id: 'h0', label: 'Normal text', run: () => setHeading(view, 0) }, ...levels]);
}

const TOOLS: Tool[] = [
  { id: 'bold', label: 'Bold', key: 'Mod-b', format: 'strong', run: (v) => toggleBold(v) },
  { id: 'italic', label: 'Italic', key: 'Mod-i', format: 'emphasis', run: (v) => toggleItalic(v) },
  { id: 'strikethrough', label: 'Strikethrough', key: 'Mod-Shift-x', format: 'strikethrough', run: (v) => toggleStrikethrough(v) },
  { id: 'highlight', label: 'Highlight', key: 'Mod-Shift-h', format: 'highlight', run: (v) => toggleHighlight(v) },
  { id: 'code', label: 'Inline code', key: 'Mod-e', format: 'code', run: (v) => toggleInlineCode(v) },
  { id: 'link', label: 'Link', key: 'Mod-k', run: (v) => toggleLink(v) },
  { id: 'heading', label: 'Heading', lines: true, run: headingMenu },
];

class FormatToolbar implements TooltipView {
  readonly dom: HTMLElement;
  private readonly view: EditorView;
  private readonly buttons: Array<{ tool: Tool; el: HTMLButtonElement }> = [];

  constructor(view: EditorView) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-format-toolbar';
    this.dom.setAttribute('role', 'toolbar');
    this.dom.setAttribute('aria-label', 'Formatting');
    const cell = isTableCell(view);
    for (const tool of TOOLS) {
      if (tool.lines && cell) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cm-format-button';
      el.tabIndex = -1;
      el.setAttribute('aria-label', tool.label);
      el.title = tool.key ? `${tool.label} (${keyLabel(tool.key)})` : tool.label;
      el.appendChild(icon(tool.id));
      el.addEventListener('click', () => {
        tool.run(this.view, el);
        // The heading menu takes the focus while it is open, and gives it back.
        if (tool.id !== 'heading') this.view.focus();
      });
      this.dom.appendChild(el);
      this.buttons.push({ tool, el });
    }
    // The selection stays, and the editor keeps the focus.
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    this.refresh();
  }

  update(update: ViewUpdate): void {
    if (update.selectionSet || update.docChanged || update.focusChanged) this.refresh();
  }

  private refresh(): void {
    const { state } = this.view;
    this.dom.hidden = !this.view.hasFocus;
    const range = state.selection.main;
    for (const { tool, el } of this.buttons) {
      const pressed = tool.format ? hasFormat(state, range, tool.format) : tool.id === 'link' ? inLink(state, range) : null;
      if (pressed === null) el.removeAttribute('aria-pressed');
      else el.setAttribute('aria-pressed', String(pressed));
    }
  }
}

const setSelecting = StateEffect.define<boolean>();

interface ToolbarState {
  /** The mouse button is down: a selection is being made. */
  selecting: boolean;
  tooltip: Tooltip | null;
}

function tooltipFor(state: EditorState, selecting: boolean, previous: Tooltip | null): Tooltip | null {
  const { selection } = state;
  const main = selection.main;
  if (selecting || main.empty || selection.ranges.length > 1 || state.readOnly) return null;
  // The same tooltip while the selection keeps its start, so it is not redrawn on every key.
  if (previous && previous.pos === main.from) return previous;
  return { pos: main.from, above: true, arrow: false, create: (view) => new FormatToolbar(view) };
}

const toolbarField = StateField.define<ToolbarState>({
  create: (state) => ({ selecting: false, tooltip: tooltipFor(state, false, null) }),
  update(value, tr) {
    let selecting = value.selecting;
    for (const e of tr.effects) if (e.is(setSelecting)) selecting = e.value;
    if (selecting === value.selecting && !tr.selection && !tr.docChanged) return value;
    return { selecting, tooltip: tooltipFor(tr.state, selecting, value.tooltip) };
  },
  provide: (field) => showTooltip.from(field, (v) => v.tooltip),
});

/** Hides the toolbar while the mouse button is down, so it appears when a drag selection ends. */
const pointerSelecting = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private readonly onUp = () => {
      if (this.view.state.field(toolbarField).selecting) this.view.dispatch({ effects: setSelecting.of(false) });
    };
    constructor(view: EditorView) {
      this.view = view;
      window.addEventListener('mouseup', this.onUp, true);
    }
    destroy() {
      window.removeEventListener('mouseup', this.onUp, true);
    }
  },
  {
    eventHandlers: {
      mousedown(event, view) {
        if (event.button === 0 && view.contentDOM.contains(event.target as Node)) view.dispatch({ effects: setSelecting.of(true) });
        return false;
      },
    },
  },
);

/** The selection toolbar (desktop Live Preview). */
export function formatToolbar(): Extension {
  return [toolbarField, pointerSelecting];
}

