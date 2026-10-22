// popup.html: the toolbar button's two choices, and what became of the clip.
import { ext } from './browser';
import type { ClipOutcome } from './clip';

export function describe(outcome: ClipOutcome): string {
  switch (outcome.status) {
    case 'saved':
      return `Saved to ${outcome.path ?? 'NotesApp'}.`;
    case 'delivered':
      return 'Opened in NotesApp: check it there and press Save.';
    case 'timeout':
      return 'NotesApp did not confirm the save. Check the NotesApp tab.';
    default:
      return outcome.error ?? 'The clip was not saved.';
  }
}

function setup(): void {
  const b = ext();
  const status = document.getElementById('status')!;
  const run = (selection: boolean) => {
    status.textContent = 'Clipping…';
    void b.runtime.sendMessage({ type: 'clip', selection }).then(
      (outcome) => (status.textContent = describe(outcome as ClipOutcome)),
      (e: unknown) => (status.textContent = String(e)),
    );
  };
  document.getElementById('clip-page')!.addEventListener('click', () => run(false));
  document.getElementById('clip-selection')!.addEventListener('click', () => run(true));
  document.getElementById('options')!.addEventListener('click', (e) => {
    e.preventDefault();
    void b.runtime.openOptionsPage();
  });
}

if (typeof document !== 'undefined' && document.getElementById('clip-page')) setup();
