// Reading view host (DESIGN §6.7): renders the session's text, patches the DOM per block, hydrates
// embeds and rich blocks (math, Mermaid, code), and handles link, tag and checkbox interaction
// through delegated listeners.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTree, useVaultSettings } from '../api/hooks';
import { splitFrontmatter } from '../features/frontmatter';
import { openSection, sectionFromText } from '../features/encryption/inline';
import { openLink, openTag } from '../features/navigation';
import { toast } from '../state/toasts';
import { usePrefs } from '../state/prefs';
import type { DocumentSession } from '../sync/DocumentSession';
import { useSessionChangeCount, useSessionSnapshot } from '../sync/useTextDocument';
import { PropertiesTable } from '../views/markdown/PropertiesTable';
import { makeEmbedContext, makeRenderContext } from './context';
import { hydrateEmbeds, unmountEmbeds, type EmbedContext } from './embeds';
import { patchChildren } from './patch';
import { lineHash, onlyCheckboxesChanged, renderNote, TASK_PATTERN, toggleTaskAtLine } from './render';
import { hydrateRich } from './rich';
import { scrollToLine } from './scroll';

const RENDER_DEBOUNCE_MS = 150;

interface Props {
  session: DocumentSession;
  /** 0-based line to scroll to after the first render (mode switch, search hit). */
  initialLine?: number | null;
  onRendered?(container: HTMLElement): void;
}

export function ReadingView({ session, initialLine, onRendered }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const changeCount = useSessionChangeCount(session);
  const { status } = useSessionSnapshot(session);
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const lastText = useRef<string | null>(null);
  const lastInputs = useRef<unknown[]>([]);
  const embedContext = useRef<EmbedContext | null>(null);
  const firstRender = useRef(true);
  const onRenderedRef = useRef(onRendered);
  const initialLineRef = useRef(initialLine);

  useLayoutEffect(() => {
    onRenderedRef.current = onRendered;
  });

  const text = session.getText();
  const frontmatter = useMemo(() => splitFrontmatter(text).yaml, [text]);
  const interactive = status === 'clean' || status === 'dirty';

  useLayoutEffect(() => {
    const el = container.current;
    if (!el || !tree) return;
    const inputs = [tree, settings, loadRemoteImages, session.path];
    const sameInputs = inputs.every((v, i) => v === lastInputs.current[i]);

    const render = () => {
      const current = session.getText();
      if (sameInputs && lastText.current !== null && onlyCheckboxesChanged(lastText.current, current)) {
        syncCheckboxes(el, current);
      } else {
        const { fragment } = renderNote(current, makeRenderContext(session.path, tree, settings, loadRemoteImages));
        patchChildren(el, fragment, unmountEmbeds);
        embedContext.current = makeEmbedContext(session.path, tree);
        hydrateEmbeds(el, embedContext.current);
        // Math, diagrams and code in new blocks only: kept blocks keep their rendering.
        hydrateRich(el);
      }
      lastText.current = current;
      lastInputs.current = inputs;
      if (firstRender.current) {
        firstRender.current = false;
        const line = initialLineRef.current;
        if (line !== null && line !== undefined) scrollToLine(el, line);
      }
      onRenderedRef.current?.(el);
    };

    if (firstRender.current || !sameInputs) {
      render();
      return;
    }
    const timer = setTimeout(render, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [changeCount, tree, settings, loadRemoteImages, session]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    for (const box of el.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
      // Transcluded tasks stay disabled: toggling them would change neither note.
      if (!box.closest('[data-embed-root]')) box.disabled = !interactive;
    }
  });

  // Mounted embeds live as long as the view; a remount (StrictMode) hydrates them again.
  useEffect(() => {
    const el = container.current;
    if (el && embedContext.current) hydrateEmbeds(el, embedContext.current);
    return () => {
      if (el) for (const child of [...el.childNodes]) unmountEmbeds(child);
    };
  }, []);

  // Delegated listeners are native: the rendered HTML (and embed roots) are not React elements,
  // and React's synthetic change events only fire for inputs it manages.
  const interactiveRef = useRef(interactive);
  useLayoutEffect(() => {
    interactiveRef.current = interactive;
  });

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const click = (e: MouseEvent) => onClick(e, session);
    const change = (e: Event) => onChange(e, session, interactiveRef.current);
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && openChip(e, session)) e.preventDefault();
    };
    el.addEventListener('click', click);
    el.addEventListener('change', change);
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('click', click);
      el.removeEventListener('change', change);
      el.removeEventListener('keydown', key);
    };
  }, [session]);

  return (
    <div className="reading-view">
      {frontmatter !== null && <PropertiesTable yaml={frontmatter} sourcePath={session.path} />}
      <div ref={container} className="markdown-rendered" tabIndex={-1} />
    </div>
  );
}

/** An encrypted section's chip (DESIGN §6.33): opens its text in a dialog. */
function openChip(e: Event, session: DocumentSession): boolean {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.encrypted-chip');
  if (!chip) return false;
  if (chip.closest('[data-embed-root]')) {
    toast('Open the note itself to unlock its encrypted text');
    return true;
  }
  const section = sectionFromText(session.getText(), chip.dataset.section ?? '');
  if (section) void openSection(session, section);
  return true;
}

function onClick(e: MouseEvent, session: DocumentSession): void {
  const target = e.target as HTMLElement;
  if (openChip(e, session)) {
    e.preventDefault();
    return;
  }
  const placeholder = target.closest<HTMLElement>('.remote-image-placeholder');
  if (placeholder) {
    const img = document.createElement('img');
    img.src = placeholder.dataset.src ?? '';
    img.alt = placeholder.dataset.alt ?? '';
    if (placeholder.dataset.width) img.width = Number(placeholder.dataset.width);
    placeholder.replaceWith(img);
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a.internal-link');
  if (link) {
    e.preventDefault();
    const href = link.dataset.href ?? '';
    const hash = href.indexOf('#');
    const source = link.closest<HTMLElement>('[data-source]')?.dataset.source ?? session.path;
    void openLink(hash < 0 ? href : href.slice(0, hash), hash < 0 ? null : href.slice(hash + 1), source);
    return;
  }
  const tag = target.closest<HTMLAnchorElement>('a.tag');
  if (tag) {
    e.preventDefault();
    openTag(tag.dataset.tag ?? '');
  }
}

function onChange(e: Event, session: DocumentSession, interactive: boolean): void {
  const box = e.target;
  if (!(box instanceof HTMLInputElement) || !box.classList.contains('task-list-item-checkbox')) return;
  if (box.closest('[data-embed-root]')) {
    // Never show a state that was not saved.
    box.checked = !box.checked;
    return;
  }
  const line = Number(box.dataset.line);
  const change = interactive ? toggleTaskAtLine(session.getText(), line, box.dataset.hash ?? '') : null;
  if (!change) {
    // The line moved during the render lag (or editing is blocked): ignore the tap.
    box.checked = !box.checked;
    return;
  }
  session.applyEdit(change);
}

/** Updates checkbox states in place after a checkbox-only change (no re-render). */
function syncCheckboxes(container: HTMLElement, text: string): void {
  const lines = text.split('\n');
  for (const box of container.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox[data-line]')) {
    if (box.closest('[data-embed-root]')) continue;
    const source = lines[Number(box.dataset.line)];
    if (source === undefined) continue;
    const m = TASK_PATTERN.exec(source);
    if (!m) continue;
    box.checked = m[2] !== ' ';
    box.dataset.hash = lineHash(source);
  }
}
