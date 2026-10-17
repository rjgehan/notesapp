// Live Preview widgets (DESIGN §6.6.1): bullets, task checkboxes, horizontal rules and the " > " of
// a heading link. Each stands in for markup without changing the document; a checkbox click is an
// ordinary edit of the one character between its brackets.
import { EditorView, WidgetType } from '@codemirror/view';
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
}

const rule = new RuleWidget();

/** The widget for `spec`. Checkboxes toggle only while the note can be written. */
export function widgetFor(spec: WidgetSpec, checkboxes: boolean): WidgetType {
  switch (spec.type) {
    case 'bullet':
      return new BulletWidget(spec.depth);
    case 'checkbox':
      return new CheckboxWidget(spec.checked, spec.depth, checkboxes);
    case 'rule':
      return rule;
    case 'text':
      return new TextWidget(spec.text, spec.className);
  }
}
