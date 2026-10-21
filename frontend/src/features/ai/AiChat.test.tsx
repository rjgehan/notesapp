import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { queryClient } from '../../api/queryClient';
import type { AiStatus, FileEntry, Settings } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { registeredPages, registeredPanels } from '../../extensions';
import { getCommand } from '../commands';
import { openPath } from '../navigation';
import { DEFAULT_SETTINGS } from '../settings';
import { AiChat, NOTICE_KEY } from './AiChat';
import { useConversations } from './conversations';

vi.mock('../navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../navigation')>()),
  openPath: vi.fn(),
}));

function entry(path: string): FileEntry {
  const name = path.split('/').pop()!;
  return { path, name, basename: name.replace(/\.md$/, ''), extension: 'md', kind: 'note', size: 10, mtime: '2026-10-20T10:00:00.000Z', version: 'a'.repeat(40), aliases: [] };
}

function status(patch: Partial<AiStatus> = {}): AiStatus {
  return {
    state: 'ready',
    reason: null,
    model: 'claude-sonnet-5-5',
    models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inputUsdPerMTok: 2, outputUsdPerMTok: 10 }],
    provider: 'claude-code',
    keyFile: 'claude-token',
    cliInstalled: true,
    keyPresent: true,
    month: '2026-10',
    monthCostUsd: 0.25,
    monthRequests: 3,
    monthlyBudgetUsd: 5,
    maxContextChars: 60000,
    fake: false,
    ...patch,
  };
}

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([e, d]) => `event:${e}\ndata:${JSON.stringify(d)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const fetchMock = vi.fn();

function setup(aiStatus: AiStatus) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: aiStatus.state !== 'off' } };
  vi.spyOn(api, 'getTree').mockResolvedValue({ eventId: 'b.1', folders: [{ path: 'Projects', name: 'Projects' }], files: [entry('Projects/Kitchen.md'), entry('Recipes.md')] });
  vi.spyOn(api, 'getSettings').mockResolvedValue({ settings, version: 'v'.repeat(40), readOnly: false });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/ai/status') return new Response(JSON.stringify(aiStatus), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/ai/ask') {
      const body = JSON.parse(init!.body as string);
      return sse([
        ['start', { model: 'claude-sonnet-5-5', sources: [{ path: 'Projects/Kitchen.md', chars: 120, truncated: false }], omitted: 0, excluded: 2 }],
        ['delta', { text: `About “${body.question}”: the budget is 12k ` }],
        ['delta', { text: '[[Projects/Kitchen]].' }],
        ['done', { model: 'claude-sonnet-5-5', stopReason: 'end_turn', refusalCategory: null, fellBack: false, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0.012, monthCostUsd: 0.262 }],
      ]);
    }
    throw new Error(`unexpected ${url}`);
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AiChat activePath="Projects/Kitchen.md" variant="panel" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  useConversations.setState({ conversations: [], currentId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  queryClient.clear();
});

describe('AiChat (ROADMAP item 18)', () => {
  it('is registered as a right panel, a page and palette commands', () => {
    registerBuiltins();
    expect(registeredPanels('right').map((p) => p.id)).toContain('ai');
    expect(registeredPages().find((p) => p.route === 'ask')?.title).toBe('Ask your vault');
    expect(getCommand('ai.summarizeNote')).toBeDefined();
    expect(getCommand('ai.summarizeWeek')).toBeDefined();
  });

  it('says it is off and links to Settings, and sends nothing', async () => {
    setup(status({ state: 'off', reason: 'Ask and summaries are switched off in Settings' }));
    expect(await screen.findByText(/Ask and summaries are off/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Settings/ })).toHaveAttribute('href', '/settings/ai');
    expect(screen.getByRole('textbox', { name: 'Question about your notes' })).toBeDisabled();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/ai/status']);
  });

  it('explains a missing key without showing one', async () => {
    setup(status({ state: 'not-configured', reason: 'no Claude Code token: claude-token does not exist', keyPresent: false }));
    expect(await screen.findByText(/The server cannot use Claude Code/)).toBeInTheDocument();
    expect(screen.getByText('claude-token', { selector: 'code' })).toBeInTheDocument();
  });

  it('warns once that notes are sent to Anthropic', async () => {
    setup(status());
    expect(await screen.findByText(/sent to Anthropic/, { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(localStorage.getItem(NOTICE_KEY)).toBe('1');
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
  });

  it('streams an answer whose citations open the note', async () => {
    localStorage.setItem(NOTICE_KEY, '1');
    setup(status());
    const input = await screen.findByRole('textbox', { name: 'Question about your notes' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'What is the budget?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const link = await screen.findByRole('link', { name: 'Projects/Kitchen' });
    expect(screen.getByText(/About “What is the budget\?”/)).toBeInTheDocument();
    expect(screen.getByText(/1 note sent · 2 excluded/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/claude-sonnet-5-5 · \$0\.01/)).toBeInTheDocument());

    fireEvent.click(link);
    expect(openPath).toHaveBeenCalledWith('Projects/Kitchen.md', null);

    const [, init] = fetchMock.mock.calls.find((c) => c[0] === '/api/ai/ask')!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ question: 'What is the budget?', activePath: 'Projects/Kitchen.md', history: [] });
  });

  it('sends earlier turns as history, and the open note only when included', async () => {
    localStorage.setItem(NOTICE_KEY, '1');
    setup(status());
    const input = await screen.findByRole('textbox', { name: 'Question about your notes' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'First?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(/About “First\?”/);
    await waitFor(() => expect(useConversations.getState().conversations[0].turns[0].status).toBe('done'));

    fireEvent.click(screen.getByRole('checkbox', { name: /Include “Kitchen”/ }));
    fireEvent.change(input, { target: { value: 'Second?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(/About “Second\?”/);
    const asks = fetchMock.mock.calls.filter((c) => c[0] === '/api/ai/ask');
    const second = JSON.parse((asks[1][1] as RequestInit).body as string);
    expect(second.activePath).toBeNull();
    expect(second.history).toEqual([{ prompt: { action: 'ask', question: 'First?' }, answer: 'About “First?”: the budget is 12k [[Projects/Kitchen]].', sources: ['Projects/Kitchen.md'] }]);
  });

  it('a link to a note that does not exist never creates one', async () => {
    localStorage.setItem(NOTICE_KEY, '1');
    setup(status());
    useConversations.getState().startTurn({ action: 'ask', question: 'Q' }, 'Q');
    const { conversationId, turnId } = { conversationId: useConversations.getState().currentId!, turnId: useConversations.getState().conversations[0].turns[0].id };
    useConversations.getState().updateTurn(conversationId, turnId, { status: 'done', answer: 'See [[Imaginary note]].' }, true);
    const link = await screen.findByRole('link', { name: 'Imaginary note' });
    fireEvent.click(link);
    expect(openPath).not.toHaveBeenCalled();
    expect(api.getTree).toHaveBeenCalled();
  });
});
