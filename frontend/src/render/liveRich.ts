// What Live Preview's rich blocks and inline math show (DESIGN §6.6.1, ROADMAP items 3 and 10): a
// callout, a `$$` block or a Mermaid diagram rendered by the reading pipeline (markdown-it with the
// rich pack, then the embeds and the rich placeholders hydrated), as the reading view did before
// it became locked Live Preview. The editor reaches these through `NoteContext.renderMarkdown` and
// `renderMath`, so its modules import neither markdown-it nor KaTeX.
import { currentSettings, currentTree } from '../api/hooks';
import type { MarkdownBlockRequest } from '../editor/context';
import { openSection, sectionFromText } from '../features/encryption/inline';
import { toast } from '../state/toasts';
import { documents } from '../sync/instance';
import { makeEmbedContext, makeRenderContext } from './context';
import { hydrateEmbeds, unmountEmbeds } from './embeds';
import { handleRenderedClick } from './interaction';
import { renderNote } from './render';
import { hydrateRich, renderMath } from './rich';

/** Renders a block of the note at `sourcePath` into `el`; returns what removes it. */
export function renderLiveMarkdown(el: HTMLElement, block: MarkdownBlockRequest, sourcePath: string): () => void {
  el.classList.add('markdown-rendered');
  const tree = currentTree();
  const { fragment } = renderNote(block.source, makeRenderContext(sourcePath, tree, currentSettings(), block.remoteImages));
  el.appendChild(fragment);
  for (const box of el.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')) {
    // Transcluded tasks stay disabled: toggling them would change neither note.
    if (!box.closest('[data-embed-root]')) box.disabled = !block.checkboxes;
  }
  hydrateEmbeds(el, makeEmbedContext(sourcePath, tree));
  hydrateRich(el);
  const onClick = (e: MouseEvent) => {
    if (openChip(e, sourcePath)) e.preventDefault();
    else handleRenderedClick(e, sourcePath);
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && openChip(e, sourcePath)) e.preventDefault();
  };
  el.addEventListener('keydown', onKey);
  const onChange = (e: Event) => {
    const box = e.target;
    if (!(box instanceof HTMLInputElement) || !box.classList.contains('task-list-item-checkbox')) return;
    // The block is drawn again from the changed text; until then (or when nothing changed) the box
    // shows what the note says, never a state that was not saved.
    const line = Number(box.dataset.line);
    const toggled = !box.closest('[data-embed-root]') && Number.isInteger(line) && block.toggleTask(line);
    if (!toggled) box.checked = !box.checked;
  };
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  return () => {
    el.removeEventListener('click', onClick);
    el.removeEventListener('change', onChange);
    el.removeEventListener('keydown', onKey);
    unmountEmbeds(el);
  };
}

/** Typesets `tex` into `el` (inline math in Live Preview); errors show inline, as KaTeX reports them. */
export function renderLiveMath(el: HTMLElement, tex: string, display: boolean): void {
  el.textContent = tex;
  renderMath(el, tex, display).catch((e: unknown) => console.warn('[rich] rendering math failed', e));
}

/** An encrypted section's chip in a rendered block (ROADMAP item 27, DESIGN §6.33): opens its text in a dialog. */
function openChip(e: Event, sourcePath: string): boolean {
  const chip = e.target instanceof Element ? e.target.closest<HTMLElement>('.encrypted-chip') : null;
  if (!chip) return false;
  if (chip.closest('[data-embed-root]')) {
    toast('Open the note itself to unlock its encrypted text');
    return true;
  }
  const session = documents.get(sourcePath);
  const section = session ? sectionFromText(session.getText(), chip.dataset.section ?? '') : null;
  if (session && section) void openSection(session, section);
  return true;
}
