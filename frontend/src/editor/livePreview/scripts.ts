// Scripts in notes (ROADMAP items 40 and 17, DESIGN §6.42) in Live Preview and locked notes: a
// ```` ```script ```` block or a ```` ```dataview ```` query shows what it produced instead of its
// code. The app runs it (`NoteContext.runScript`, the QuickJS sandbox of scripts/), and its output,
// Markdown made by scripts/output.ts, renders through `renderMarkdown` with images from other sites
// off; their click-to-load placeholders are removed, so nothing a script writes can load a URL.
//
// While editing, the code shows while the selection touches the block (rich.ts decides, as for
// callouts); </> puts the caret in it. A locked note shows the code under the output on </>.
// ↻ runs the block again. Results are kept per note, kind and code, so a block that scrolls out
// and back, or that the caret enters and leaves, does not run again; they go stale when a note
// the script read changes (`invalidateScripts`, from the app's event handlers), at local
// midnight (`today()`), and on ↻. A stale block that shows runs again (debounced).
import { EditorSelection } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { noteContext, type NoteContext, type ScriptOutcome } from '../context';
import { formulaEngine } from '../../formulas/load';
import { formulaResults } from './formulas';
import { remeasureOnChange } from './embeds';

export type ScriptKind = 'script' | 'dataview';
/** The per-device preference: run as a note shows, run on a click, or show the code. */
export type ScriptsMode = 'auto' | 'ask' | 'off';

/** How long after a relevant change a showing block runs again. */
export const RERUN_DEBOUNCE_MS = 1000;
const MAX_CACHED = 200;

/** The code of a fenced block (its lines between the fences; an unclosed fence runs to the end). */
export function fencedCode(block: string): string {
  const lines = block.split('\n');
  const open = /^\s*(`{3,}|~{3,})/.exec(lines[0] ?? '');
  lines.shift();
  if (open && lines.length > 0) {
    const fence = open[1];
    const last = lines[lines.length - 1].trim();
    if (last.length >= fence.length && last === fence[0].repeat(last.length)) lines.pop();
  }
  return lines.join('\n');
}

// ---------- results, shared by the widgets ----------

interface Run {
  key: string;
  path: string;
  outcome: ScriptOutcome | null;
  running: boolean;
  /** Something it read changed (or ↻): it runs again when it shows. */
  stale: boolean;
  /** "Ask before running": the user clicked Run (for this session). */
  allowed: boolean;
  /** The widgets showing it: each redraws when the run changes. */
  listeners: Set<() => void>;
  /** Runs it (the last widget's app and editor). */
  start: (() => Promise<ScriptOutcome>) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const runs = new Map<string, Run>();
let midnightTimer: ReturnType<typeof setTimeout> | null = null;

function runFor(path: string, kind: ScriptKind, code: string): Run {
  const key = `${path}\n${kind}\n${code}`;
  let run = runs.get(key);
  if (run) {
    // Most recently used last.
    runs.delete(key);
    runs.set(key, run);
    return run;
  }
  run = { key, path, outcome: null, running: false, stale: false, allowed: false, listeners: new Set(), start: null, timer: null };
  runs.set(key, run);
  for (const [k, r] of runs) {
    if (runs.size <= MAX_CACHED) break;
    if (r.listeners.size === 0 && !r.running) runs.delete(k);
  }
  return run;
}

function notify(run: Run): void {
  for (const f of [...run.listeners]) f();
}

function execute(run: Run): void {
  if (run.running || !run.start) return;
  if (run.timer !== null) clearTimeout(run.timer);
  run.timer = null;
  run.running = true;
  run.stale = false;
  notify(run);
  run
    .start()
    .catch((e: unknown): ScriptOutcome => ({ markdown: '', error: { kind: 'host', line: null, message: e instanceof Error ? e.message : String(e) }, reads: { paths: new Set(), broad: false } }))
    .then((outcome) => {
      run.running = false;
      run.outcome = outcome;
      notify(run);
      // Changed again while it ran.
      if (run.stale && run.listeners.size > 0) schedule(run);
    });
}

function schedule(run: Run): void {
  if (run.timer !== null || run.listeners.size === 0) return;
  run.timer = setTimeout(() => {
    run.timer = null;
    if (run.listeners.size > 0) execute(run);
  }, RERUN_DEBOUNCE_MS);
}

function scheduleMidnight(): void {
  if (midnightTimer !== null) return;
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    invalidateScripts(null);
    if ([...runs.values()].some((r) => r.listeners.size > 0)) scheduleMidnight();
  }, next.getTime() - now.getTime());
}

/**
 * Notes changed (created, saved, deleted, moved: their paths), or `null` for "anything may have"
 * (midnight, the vault reloaded): the results that read them go stale, and the showing ones run again.
 */
export function invalidateScripts(paths: readonly string[] | null): void {
  for (const run of runs.values()) {
    const reads = run.outcome?.reads;
    const relevant = paths === null || !reads || reads.broad || paths.some((p) => reads.paths.has(p) || p === run.path);
    if (!relevant) continue;
    run.stale = true;
    if (run.listeners.size > 0 && (run.outcome !== null || run.running)) schedule(run);
  }
}

/** Tests: forget every result. */
export function resetScriptsForTests(): void {
  for (const r of runs.values()) if (r.timer !== null) clearTimeout(r.timer);
  runs.clear();
  if (midnightTimer !== null) clearTimeout(midnightTimer);
  midnightTimer = null;
}

// ---------- the widget ----------

/** Evaluates a formula for `fn` and `formula()`: with the note's tables (item 39) when `note`. */
async function evaluateIn(view: EditorView, expression: string, note: boolean): Promise<unknown> {
  const engine = await formulaEngine();
  const results = note ? formulaResults(view.state) : null;
  if (results) return results.evaluate(expression);
  const alone = engine.computeNote({ tables: [] });
  try {
    return alone.evaluate(expression);
  } finally {
    alone.destroy();
  }
}

/** Removes what could load something from another site from rendered script output (outside embedded notes). */
export function stripRemote(el: HTMLElement): void {
  for (const p of el.querySelectorAll<HTMLElement>('.remote-image-placeholder')) {
    if (p.closest('[data-embed-root]')) continue;
    const text = document.createElement('span');
    text.className = 'cm-lp-script-noimage';
    text.textContent = p.dataset.alt || p.textContent || 'Image';
    text.title = 'Scripts cannot show images from other sites';
    p.replaceWith(text);
  }
}

function button(label: string, title: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cm-lp-script-button ${className}`;
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

const cleanups = new WeakMap<HTMLElement, () => void>();

export class ScriptBlockWidget extends WidgetType {
  readonly kind: ScriptKind;
  readonly code: string;
  readonly path: string;
  readonly mode: ScriptsMode;
  readonly locked: boolean;
  constructor(kind: ScriptKind, code: string, path: string, mode: ScriptsMode, locked: boolean) {
    super();
    this.kind = kind;
    this.code = code;
    this.path = path;
    this.mode = mode;
    this.locked = locked;
  }
  override eq(other: ScriptBlockWidget): boolean {
    return other.kind === this.kind && other.code === this.code && other.path === this.path && other.mode === this.mode && other.locked === this.locked;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = `cm-lp-script cm-lp-script-${this.kind}`;
    const note = view.state.facet(noteContext);
    const run = runFor(this.path, this.kind, this.code);
    if (note?.runScript) {
      const runScript = note.runScript.bind(note);
      const { kind, code } = this;
      run.start = () => runScript({ kind, source: code, evaluate: (expression, inNote) => evaluateIn(view, expression, inNote) });
    }
    const bar = document.createElement('div');
    bar.className = 'cm-lp-script-bar';
    const body = document.createElement('div');
    body.className = 'cm-lp-script-body';
    const source = document.createElement('pre');
    source.className = 'cm-lp-script-code';
    source.textContent = this.code;
    source.hidden = true;
    el.append(bar, body, source);

    bar.append(
      button('↻', this.kind === 'dataview' ? 'Run the query again' : 'Run the script again', 'is-rerun', () => {
        run.allowed = true;
        execute(run);
      }),
      button('</>', this.kind === 'dataview' ? 'Show the query' : 'Show the code', 'is-code', () => {
        if (!this.locked && view.state.facet(EditorView.editable) && !view.state.readOnly) {
          // The caret in the block shows its code, to edit (rich.ts).
          const at = view.state.doc.lineAt(view.posAtDOM(el)).to + 1;
          view.dispatch({ selection: EditorSelection.cursor(Math.min(at, view.state.doc.length)), scrollIntoView: false, userEvent: 'select.pointer' });
          view.focus();
        } else {
          source.hidden = !source.hidden;
          view.requestMeasure();
        }
      }),
    );

    let unmount: () => void = () => {};
    const draw = () => {
      unmount();
      unmount = () => {};
      body.replaceChildren();
      el.classList.toggle('is-running', run.running);
      if (!run.outcome && this.mode === 'ask' && !run.allowed) {
        const ask = document.createElement('div');
        ask.className = 'cm-lp-script-ask';
        const pre = document.createElement('pre');
        pre.className = 'cm-lp-script-code';
        pre.textContent = this.code;
        ask.append(
          pre,
          button(this.kind === 'dataview' ? 'Run query' : 'Run script', 'Run it in the sandbox', 'is-run', () => {
            run.allowed = true;
            execute(run);
          }),
        );
        body.appendChild(ask);
        return;
      }
      if (!run.outcome) {
        const wait = document.createElement('div');
        wait.className = 'cm-lp-script-status';
        wait.textContent = note?.runScript ? 'Running…' : 'Scripts do not run here';
        body.appendChild(wait);
        return;
      }
      const { markdown, error } = run.outcome;
      if (markdown.trim() !== '' && note?.renderMarkdown) {
        const out = document.createElement('div');
        out.className = 'cm-lp-script-output';
        unmount = note.renderMarkdown(out, { source: markdown, remoteImages: false, checkboxes: false, toggleTask: () => false });
        stripRemote(out);
        body.appendChild(out);
      } else if (!error) {
        const empty = document.createElement('div');
        empty.className = 'cm-lp-script-status';
        empty.textContent = this.kind === 'dataview' ? 'No results' : 'The script showed nothing';
        body.appendChild(empty);
      }
      if (error) {
        const err = document.createElement('div');
        err.className = 'cm-lp-script-error';
        err.setAttribute('role', 'alert');
        err.textContent = (error.line !== null ? `Line ${error.line}: ` : '') + error.message;
        body.appendChild(err);
      }
      view.requestMeasure();
    };
    run.listeners.add(draw);
    draw();
    scheduleMidnight();
    if ((this.mode === 'auto' || run.allowed) && (!run.outcome || run.stale)) {
      // Not inside the update that is drawing this widget.
      queueMicrotask(() => {
        if (run.listeners.has(draw)) execute(run);
      });
    }

    const unmeasure = remeasureOnChange(view, el);
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || this.locked || !view.state.facet(EditorView.editable) || view.state.readOnly) return;
      if (e.target instanceof Element && e.target.closest('a, input, button, summary, .callout-fold, [data-embed-root], .cm-lp-script-output')) return;
      e.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(el)), scrollIntoView: false, userEvent: 'select.pointer' });
      view.focus();
    };
    el.addEventListener('mousedown', onDown);
    cleanups.set(el, () => {
      el.removeEventListener('mousedown', onDown);
      run.listeners.delete(draw);
      unmeasure();
      unmount();
    });
    return el;
  }
  override destroy(dom: HTMLElement): void {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override get estimatedHeight(): number {
    return 80;
  }
}

/** Whether `note` can run scripts (the app's editors; not tests without it, nor canvas cards). */
export function canRunScripts(note: NoteContext | null): boolean {
  return !!note?.runScript && !!note.renderMarkdown;
}
