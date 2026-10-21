// Live Preview widgets (DESIGN §6.6.1): bullets, task checkboxes, horizontal rules, the " > " of
// a heading link, footnote numbers, code fences, and (embeds.ts) images and embeds. Each stands in
// for markup without changing the document; a checkbox click is an ordinary edit of the one
// character between its brackets.
import { EditorView, WidgetType } from '@codemirror/view';
import type { NoteContext } from '../context';
import { embedWidget } from './embeds';
import { showFootnote, type FootnoteIndex } from './footnotes';
import { LIST_INDENT_EM, type WidgetSpec } from './model';

/** Bullet glyphs by nesting level, as the reading view's disc, circle and square. */
const BULLETS = ['•', '◦', '▪'];

/** Toggles the task whose `[ ]` starts at `pos`: `[ ]` becomes `[x]`, `[x]` and `[X]` become `[ ]`. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const box = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(box)) return false;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: box[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle' });
  return true;
}

class BulletWidget extends WidgetType {
  readonly depth: number;
  constructor(depth: number) {
    super();
    this.depth = depth;
  }
  override eq(other: BulletWidget): boolean {
    return other.depth === this.depth;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-bullet';
    el.style.width = `${(this.depth + 1) * LIST_INDENT_EM}em`;
    el.setAttribute('aria-hidden', 'true');
    const dot = document.createElement('span');
    dot.className = 'cm-lp-bullet-dot';
    dot.textContent = BULLETS[this.depth % BULLETS.length];
    el.appendChild(dot);
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  readonly checked: boolean;
  readonly depth: number;
  readonly enabled: boolean;
  constructor(checked: boolean, depth: number, enabled: boolean) {
    super();
    this.checked = checked;
    this.depth = depth;
    this.enabled = enabled;
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.depth === this.depth && other.enabled === this.enabled;
  }
  toDOM(view: EditorView): HTMLElement {
    // The whole box (the list indent included) is the tap target; the checkbox only shows the state.
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-task-box';
    wrap.style.width = `${(this.depth + 1) * LIST_INDENT_EM}em`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task-list-item-checkbox cm-lp-checkbox';
    box.tabIndex = -1;
    box.checked = this.checked;
    box.disabled = !this.enabled;
    box.setAttribute('aria-label', this.checked ? 'Completed task' : 'Task');
    // The editor ignores the box's events (ignoreEvent), so a tap neither moves the caret nor opens
    // the keyboard; the toggle is a document change, and the redrawn widget shows the new state.
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.addEventListener('click', (e) => {
      e.preventDefault();
      if (box.disabled) return;
      // The widget starts at the list marker (or the box); its `[ ]` is the first one after that.
      const pos = view.posAtDOM(wrap);
      const at = view.state.sliceDoc(pos, view.state.doc.lineAt(pos).to).search(/\[[ xX]\]/);
      if (at >= 0) toggleTaskAt(view, pos + at);
    });
    wrap.appendChild(box);
    return wrap;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-rule';
    el.setAttribute('role', 'separator');
    return el;
  }
}

class TextWidget extends WidgetType {
  readonly text: string;
  readonly className: string;
  constructor(text: string, className: string) {
    super();
    this.text = text;
    this.className = className;
  }
  override eq(other: TextWidget): boolean {
    return other.text === this.text && other.className === this.className;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.className;
    el.textContent = this.text;
    return el;
  }
  override ignoreEvent(): boolean {
    // The " > " of a heading link is part of the link: a click on it follows the link.
    return false;
  }
}

const rule = new RuleWidget();

// ---------- footnotes and code fences (ROADMAP 10b) ----------

/** A footnote reference or inline footnote: its number, superscript. A click or tap shows its text. */
class FootnoteWidget extends WidgetType {
  readonly number: number | null;
  readonly label: string | null;
  constructor(number: number | null, label: string | null) {
    super();
    this.number = number;
    this.label = label;
  }
  override eq(other: FootnoteWidget): boolean {
    return other.number === this.number && other.label === this.label;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('sup');
    el.className = this.number === null ? 'cm-lp-footnote is-missing' : 'cm-lp-footnote';
    // Without a definition the reference reads as typed, as in the reading of the note.
    el.textContent = this.number === null ? `[^${this.label ?? ''}]` : `[${this.number}]`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', this.number === null ? `Footnote ${this.label ?? ''} (no text)` : `Footnote ${this.number}`);
    // The caret (and the phone's keyboard) stay put; the tap shows the footnote's text.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch({ effects: showFootnote.of(view.posAtDOM(el)) });
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** The label of a footnote's definition, as its number (`1.`), or its label when nothing refers to it. */
class FootnoteLabelWidget extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  override eq(other: FootnoteLabelWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-footnote-label';
    el.textContent = this.text;
    return el;
  }
}

/** A code block's opening fence: the block's language, small and faint. */
class FenceWidget extends WidgetType {
  readonly language: string;
  constructor(language: string) {
    super();
    this.language = language;
  }
  override eq(other: FenceWidget): boolean {
    return other.language === this.language;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-fence';
    el.textContent = this.language;
    return el;
  }
}

/** What the widgets need besides their spec. */
export interface WidgetContext {
  /** Task checkboxes can be toggled (false while the note cannot be written). */
  checkboxes: boolean;
  /** Images from other sites load (the per-device preference); otherwise a click loads one. */
  remoteImages: boolean;
  /** The app (link resolution, embeds); null in a plain editor. */
  note: NoteContext | null;
  /** The note's footnotes, for their numbers. */
  footnotes(): FootnoteIndex;
}

/** The widget for `spec`. */
export function widgetFor(spec: WidgetSpec, ctx: WidgetContext): WidgetType {
  switch (spec.type) {
    case 'bullet':
      return new BulletWidget(spec.depth);
    case 'checkbox':
      return new CheckboxWidget(spec.checked, spec.depth, ctx.checkboxes);
    case 'rule':
      return rule;
    case 'text':
      return new TextWidget(spec.text, spec.className);
    case 'embed':
      return embedWidget(spec.embed, ctx.note, ctx.remoteImages);
    case 'footnote': {
      const index = ctx.footnotes();
      return new FootnoteWidget(spec.label === null ? index.inlineNumber(spec.at) : index.number(spec.label), spec.label);
    }
    case 'footnote-label': {
      const n = ctx.footnotes().number(spec.label);
      return new FootnoteLabelWidget(n === null ? `${spec.label}.` : `${n}.`);
    }
    case 'fence':
      return new FenceWidget(spec.language);
  }
}
