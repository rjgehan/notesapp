// Pins the shell to the visual viewport (DESIGN §6.16): `--vvh` and `--vv-top` follow
// visualViewport, `keyboard-open` is set while the on-screen keyboard takes a quarter of it, and
// the caret of the focused editor is kept in view when the visible area shrinks.
import { EditorView } from '@codemirror/view';
import { activeEditor } from './activeEditor';

/** Scrolls the focused editor's caret back into view (keyboard opened, toolbar shown). */
export function revealCaret(): void {
  const view = activeEditor();
  if (!view || !view.hasFocus) return;
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) });
}

export function installViewportVars(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let frame = 0;
  let lastHeight = 0;
  const update = () => {
    frame = 0;
    const height = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    root.style.setProperty('--vvh', `${height}px`);
    root.style.setProperty('--vv-top', `${top}px`);
    root.classList.toggle('keyboard-open', height < 0.75 * window.innerHeight);
    if (height < lastHeight) revealCaret();
    lastHeight = height;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  return () => {
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
