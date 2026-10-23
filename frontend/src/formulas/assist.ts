// Function help while a formula is typed (DESIGN §6.21.5, §6.42), the same in the spreadsheet
// view's cell editor and formula bar and in a note table's cell: typing `=SU` lists SUM, SUMIF, …
// (arrows and Enter or Tab pick one, or a click or tap); picking puts in `SUM(` with the caret
// inside, and inside a call a one-line hint shows its signature with the current argument in bold.
// A small floating box under the caret, fixed to the window, so a table's or grid's scrolling
// never clips it. A tap on a suggestion keeps the field focused, so a phone's keyboard stays up.
// Loaded lazily (the tables import it when a formula is first edited); the function list comes
// from the engine's chunk.
import { callAt, completionAt, signatureParts, suggestFunctions, type FunctionInfo } from '../sheets/formulaText';
import './assist.css';

/** The field a formula is typed in: a text input, or a cell's CodeMirror editor. */
export interface AssistField {
  text(): string;
  caret(): number;
  /** Replaces `from`…`to` with `insert` and puts the caret at `caret`, as typing would. */
  replace(from: number, to: number, insert: string, caret: number): void;
  /** Where the caret (or the field) is on screen. */
  caretRect(): { left: number; top: number; bottom: number } | null;
}

export type AssistKey = 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Escape';

export class FormulaAssist {
  private readonly field: AssistField;
  private readonly catalog: () => readonly FunctionInfo[] | null;
  private readonly box: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly hint: HTMLDivElement;
  private items: FunctionInfo[] = [];
  private selected = 0;
  private from = 0;
  /** Escape closed the list for this word: it stays closed until the word changes. */
  private dismissed: string | null = null;

  constructor(field: AssistField, catalog: () => readonly FunctionInfo[] | null) {
    this.field = field;
    this.catalog = catalog;
    this.box = document.createElement('div');
    this.box.className = 'formula-assist';
    this.box.hidden = true;
    this.list = document.createElement('ul');
    this.list.className = 'formula-assist-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Functions');
    this.hint = document.createElement('div');
    this.hint.className = 'formula-assist-hint';
    this.box.append(this.list, this.hint);
    // The field keeps the focus (and a phone its keyboard): no press here moves it.
    this.box.addEventListener('pointerdown', (e) => e.preventDefault());
    this.box.addEventListener('mousedown', (e) => e.preventDefault());
    this.box.addEventListener('touchend', this.onTouchEnd, { passive: false });
    this.box.addEventListener('click', this.onClick);
    document.body.appendChild(this.box);
  }

  /** Whether the suggestion list is showing (it then takes the arrows, Enter, Tab and Escape). */
  isOpen(): boolean {
    return !this.box.hidden && this.items.length > 0;
  }

  /** Recomputes after typing or a caret move. */
  update(): void {
    const text = this.field.text();
    const caret = this.field.caret();
    const word = completionAt(text, caret);
    const catalog = this.catalog();
    const key = word ? `${word.from}:${word.prefix}` : null;
    if (key !== this.dismissed) this.dismissed = null;
    const items = word && catalog && this.dismissed === null ? suggestFunctions(catalog, word.prefix) : [];
    const same = items.length === this.items.length && items.every((f, i) => f === this.items[i]);
    this.items = items;
    if (!same) this.selected = 0;
    this.from = word?.from ?? caret;
    const call = items.length === 0 && catalog ? callAt(text, caret) : null;
    const info = call ? catalog!.find((f) => f.name === call.name) : undefined;
    this.renderList();
    this.renderHint(items.length > 0 ? items[this.selected] : info, items.length > 0 ? -1 : (call?.arg ?? -1));
    this.box.hidden = items.length === 0 && !info;
    if (!this.box.hidden) this.position();
  }

  /** A key in the field; true when the list took it. */
  key(key: AssistKey): boolean {
    if (!this.isOpen()) return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const n = this.items.length;
      this.selected = (this.selected + (key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.renderList();
      this.renderHint(this.items[this.selected], -1);
      return true;
    }
    if (key === 'Escape') {
      const word = completionAt(this.field.text(), this.field.caret());
      this.dismissed = word ? `${word.from}:${word.prefix}` : null;
      this.update();
      return true;
    }
    this.accept(this.selected);
    return true;
  }

  hide(): void {
    this.box.hidden = true;
    this.items = [];
  }

  destroy(): void {
    this.box.remove();
  }

  /** Puts in the chosen function's name and its `(`, with the caret inside. */
  private accept(index: number): void {
    const f = this.items[index];
    if (!f) return;
    const text = this.field.text();
    const caret = this.field.caret();
    const opened = text[caret] === '(';
    const insert = opened ? f.name : `${f.name}(`;
    this.field.replace(this.from, caret, insert, this.from + f.name.length + 1);
    this.items = [];
    this.update();
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.items.map((f, i) => {
        const li = document.createElement('li');
        li.className = 'formula-assist-item';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === this.selected));
        li.dataset.index = String(i);
        li.textContent = f.name;
        return li;
      }),
    );
    this.list.hidden = this.items.length === 0;
    this.list.children[this.selected]?.scrollIntoView?.({ block: 'nearest' });
  }

  private renderHint(info: FunctionInfo | undefined, arg: number): void {
    if (!info) {
      this.hint.hidden = true;
      this.hint.replaceChildren();
      return;
    }
    this.hint.hidden = false;
    this.hint.replaceChildren(
      ...signatureParts(info, arg).map((p) => {
        if (!p.active) return document.createTextNode(p.text);
        const b = document.createElement('b');
        b.textContent = p.text;
        return b;
      }),
    );
  }

  private position(): void {
    const rect = this.field.caretRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
    const box = this.box;
    box.style.left = '0px';
    box.style.top = '0px';
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, width - w - 8));
    // Under the caret, or above it when the keyboard leaves no room below.
    const below = rect.bottom + 4;
    const top = below + h > height - 4 && rect.top - h - 4 > 0 ? rect.top - h - 4 : below;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  private indexAt(target: EventTarget | null): number | null {
    const li = target instanceof Element ? target.closest<HTMLElement>('.formula-assist-item') : null;
    return li ? Number(li.dataset.index) : null;
  }

  private onTouchEnd = (e: TouchEvent) => {
    const i = this.indexAt(e.target);
    // No click (nor its focus change) follows: the keyboard stays up.
    e.preventDefault();
    if (i !== null) this.accept(i);
  };

  private onClick = (e: MouseEvent) => {
    const i = this.indexAt(e.target);
    if (i !== null) this.accept(i);
  };
}

/** Sets an input's value the way typing does, so React (Glide's editor, the formula bar) takes it. */
export function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** An input or text area as an assist field (the caret's place is the field's left edge and bottom). */
export function inputField(el: HTMLInputElement | HTMLTextAreaElement): AssistField {
  return {
    text: () => el.value,
    caret: () => el.selectionStart ?? el.value.length,
    replace(from, to, insert, caret) {
      setInputValue(el, el.value.slice(0, from) + insert + el.value.slice(to));
      el.setSelectionRange(caret, caret);
    },
    caretRect() {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, bottom: r.bottom };
    },
  };
}
