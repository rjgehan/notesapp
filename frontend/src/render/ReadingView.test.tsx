import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { ReadingView } from './ReadingView';

const NOTE = 'Intro paragraph\n\n![[pic.png]]\n\n- [ ] first task\n- [x] second task\n';

async function setup() {
  const vault = new MockVault(false);
  vault.createFile({ path: 'n.md', content: NOTE }, 'o');
  await vault.uploadRaw('pic.png', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'fail', 'o');
  const fake = fakeApi(vault);
  const session = new DocumentSession('n.md', sessionDeps(fake.api));
  await session.ready;
  const qc = new QueryClient();
  qc.setQueryData(['tree'], vault.getTree());
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReadingView session={session} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { vault, session, view };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReadingView', () => {
  it('a click on a transcluded task never shows a state that was not saved (FE-9, ux)', async () => {
    const { session, view } = await setup();
    const container = view.container.querySelector('.markdown-rendered')!;
    // An embed root as NoteEmbed mounts it, with an (enabled) task box inside.
    const embed = document.createElement('div');
    embed.setAttribute('data-embed-root', '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task-list-item-checkbox';
    embed.appendChild(box);
    container.appendChild(embed);
    const before = session.getText();
    act(() => {
      box.checked = true;
      fireEvent.change(box);
    });
    expect(box.checked).toBe(false);
    expect(session.getText()).toBe(before);
  });

  it('toggling a checkbox edits the session without re-rendering the blocks', async () => {
    const { session, view } = await setup();
    const container = view.container.querySelector('.markdown-rendered')!;
    const img = container.querySelector('img');
    const paragraph = container.querySelector('p');
    const boxes = container.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox');
    expect(img).not.toBeNull();

    act(() => {
      boxes[0].checked = true;
      fireEvent.change(boxes[0]);
    });
    expect(session.getText()).toContain('- [x] first task');
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(container.querySelector('img')).toBe(img);
    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelectorAll('input.task-list-item-checkbox')[0]).toBe(boxes[0]);
    expect(boxes[0].checked).toBe(true);
  });

  it('keeps the image when an unrelated paragraph changes', async () => {
    const { session, view } = await setup();
    const container = view.container.querySelector('.markdown-rendered')!;
    const img = container.querySelector('img');
    act(() => session.applyEdit({ from: 0, to: 5, insert: 'Opening' }));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(container.querySelector('p')?.textContent).toBe('Opening paragraph');
    expect(container.querySelector('img')).toBe(img);
  });

  it('ignores a tap on a checkbox whose line moved', async () => {
    const { session, view } = await setup();
    const box = view.container.querySelector<HTMLInputElement>('input.task-list-item-checkbox')!;
    box.dataset.hash = 'stale';
    act(() => {
      box.checked = true;
      fireEvent.change(box);
    });
    expect(box.checked).toBe(false);
    expect(session.getText()).toBe(NOTE);
  });
});
