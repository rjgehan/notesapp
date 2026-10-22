import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../api/mock/vault';
import { DocumentSession } from '../../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../../test/fakes';
import KanbanBoard from './KanbanBoard';

const SETTINGS = '%% kanban:settings\n```\n{"kanban-plugin":"basic", "lane-width": 270}\n```\n%%\n';
const BOARD = ['---', '', 'kanban-plugin: basic', '', '---', '', '## To do', '', '- [ ] Call [[Bob]] @{2020-01-02}', '- [ ] Second', '', '', '## Done', '', '**Complete**', '', '', '', '', SETTINGS].join('\n');

async function setup(text = BOARD, onShowMarkdown = () => {}) {
  const vault = new MockVault(false);
  vault.createFile({ path: 'Board.md', content: text }, 'o');
  vault.createFile({ path: 'Bob.md', content: 'Bob' }, 'o');
  const fake = fakeApi(vault);
  const session = new DocumentSession('Board.md', sessionDeps(fake.api));
  await session.ready;
  const qc = new QueryClient();
  qc.setQueryData(['tree'], vault.getTree());
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <KanbanBoard session={session} readOnly={false} onShowMarkdown={onShowMarkdown} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(50));
  return { session, view };
}

const lane = (name: string) => screen.getByRole('region', { name: 'Board.md board' }).querySelector<HTMLElement>(`[aria-label="${name}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('KanbanBoard', () => {
  it('shows the lanes and cards, with links, dates and the complete lane', async () => {
    await setup();
    const todo = lane('To do');
    expect(within(todo).getAllByRole('listitem')).toHaveLength(2);
    const link = todo.querySelector<HTMLAnchorElement>('a.internal-link');
    expect(link?.textContent).toBe('Bob');
    expect(within(todo).getByText('2020-01-02').closest('.kanban-chip')).toHaveClass('is-overdue');
    expect(within(lane('Done')).getByText('No cards')).toBeInTheDocument();
    expect(screen.getByTitle('Cards moved here are marked as done')).toBeInTheDocument();
  });

  it('moves a card with the keyboard into the complete lane, checking it, and keeps the settings block', async () => {
    const { session } = await setup();
    const card = lane('To do').querySelectorAll<HTMLElement>('[data-board-card]')[1];
    act(() => {
      card.focus();
      fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    });
    const text = session.getText();
    expect(text).toContain('## Done\n\n**Complete**\n- [x] Second\n');
    expect(text).toContain('## To do\n\n- [ ] Call [[Bob]] @{2020-01-02}\n\n\n## Done');
    expect(text.endsWith('\n\n' + SETTINGS)).toBe(true);
  });

  it('archives a card from its menu and lists it in the archive', async () => {
    const { session } = await setup();
    const card = lane('To do').querySelectorAll<HTMLElement>('[data-board-card]')[1];
    fireEvent.click(within(card).getByRole('button', { name: 'Card actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(session.getText()).toContain('***\n\n## Archive\n\n- [ ] Second\n\n' + SETTINGS);
    fireEvent.click(screen.getByRole('button', { name: /Archive \(1\)/ }));
    const archive = screen.getByRole('region', { name: 'Archived cards' });
    expect(within(archive).getByText('Second')).toBeInTheDocument();
    fireEvent.click(within(archive).getByRole('button', { name: 'Restore to the first lane' }));
    expect(session.getText()).not.toContain('## Archive');
    expect(within(lane('To do')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('moves a lane right from its menu', async () => {
    const { session } = await setup();
    fireEvent.click(within(lane('To do')).getByRole('button', { name: 'More for lane To do' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move lane right' }));
    expect(session.getText().indexOf('## Done')).toBeLessThan(session.getText().indexOf('## To do'));
  });

  it('opens an editor on a card when it is clicked', async () => {
    await setup();
    const card = lane('To do').querySelectorAll<HTMLElement>('[data-board-card]')[1];
    fireEvent.click(within(card).getByText('Second'));
    expect(card.querySelector('.kanban-card-editor .cm-editor')).not.toBeNull();
  });

  it('shows a board with lines it cannot hold without editing, and offers the Markdown', async () => {
    const onShowMarkdown = vi.fn();
    const { session } = await setup(BOARD.replace('- [ ] Second', '- [ ] Second\n\nA stray paragraph'), onShowMarkdown);
    expect(screen.getByRole('note')).toHaveTextContent('Line 12 is not part of a card or a lane');
    expect(screen.queryByRole('button', { name: /Add card/ })).toBeNull();
    const before = session.getText();
    const card = lane('To do').querySelectorAll<HTMLElement>('[data-board-card]')[1];
    act(() => {
      card.focus();
      fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    });
    expect(session.getText()).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: /Open as Markdown/ }));
    expect(onShowMarkdown).toHaveBeenCalled();
  });
});
