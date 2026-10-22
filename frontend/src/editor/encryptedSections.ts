// Inline encrypted sections in the note editor (DESIGN §6.33): each `%%🔐β …🔐%%` shows as one
// atomic lock chip instead of its base64. Clicking it (or Enter on it from the palette command)
// opens the section's text in a dialog; the decrypted text never enters the document.
import { RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { openSection } from '../features/encryption/inline';
import { findSections, LOCK, sectionAt, type InlineSection } from '../features/encryption/meld';
import { documents } from '../sync/instance';
import { noteContext } from './context';

class LockWidget extends WidgetType {
  readonly section: InlineSection;

  constructor(section: InlineSection) {
    super();
    this.section = section;
  }

  override eq(other: LockWidget): boolean {
    return other.section.text === this.section.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'encrypted-chip';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', this.section.hint ? `Encrypted text, hint: ${this.section.hint}` : 'Encrypted text');
    el.title = 'Encrypted text: click to open';
    el.textContent = this.section.hint ? `🔒 Encrypted · ${this.section.hint}` : '🔒 Encrypted';
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const from = view.posAtDOM(el);
      openSectionIn(view, from);
    });
    return el;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    // Sections are single-line: scan whole lines of the visible range.
    const start = doc.lineAt(from).from;
    const end = doc.lineAt(to).to;
    const text = doc.sliceString(start, end);
    if (!text.includes(LOCK)) continue;
    for (const s of findSections(text)) {
      // Two visible ranges can share a line: add each section once, in order.
      if (start + s.from < last) continue;
      last = start + s.to;
      builder.add(start + s.from, start + s.to, Decoration.replace({ widget: new LockWidget({ ...s, from: start + s.from, to: start + s.to }) }));
    }
  }
  return builder.finish();
}

const chips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** The section at `pos` in the editor's note, or null. */
export function sectionInState(state: EditorState, pos: number): InlineSection | null {
  const line = state.doc.lineAt(pos);
  const found = sectionAt(line.text, pos - line.from);
  return found ? { ...found, from: line.from + found.from, to: line.from + found.to } : null;
}

/** Opens the section at `pos` (the chip's position, or the cursor). Returns whether there was one. */
export function openSectionIn(view: EditorView, pos: number): boolean {
  const section = sectionInState(view.state, pos);
  const ctx = view.state.facet(noteContext);
  const session = ctx ? documents.get(ctx.path()) : undefined;
  if (!section || !session) return false;
  void openSection(session, section);
  return true;
}

export const encryptedSections = [chips];
