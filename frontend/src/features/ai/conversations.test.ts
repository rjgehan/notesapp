import { beforeEach, describe, expect, it } from 'vitest';
import { CONVERSATIONS_KEY, MAX_CONVERSATIONS, currentConversation, historyOf, loadStored, trimForStorage, useConversations, type Conversation } from './conversations';

beforeEach(() => {
  useConversations.setState({ conversations: [], currentId: null });
});

describe('per-device conversations (DESIGN §6.31)', () => {
  it('starts a conversation with the first turn and keeps it in localStorage', () => {
    const { conversationId, turnId } = useConversations.getState().startTurn({ action: 'ask', question: 'Budget?' }, 'Budget?');
    const conversation = currentConversation();
    expect(conversation?.id).toBe(conversationId);
    expect(conversation?.title).toBe('Budget?');
    expect(conversation?.turns[0]).toMatchObject({ id: turnId, status: 'streaming', answer: '' });
    const stored = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)!);
    expect(stored.currentId).toBe(conversationId);
  });

  it('streams into a turn and saves it once it is done', () => {
    const store = useConversations.getState();
    const { conversationId, turnId } = store.startTurn({ action: 'ask', question: 'Q' }, 'Q');
    store.updateTurn(conversationId, turnId, (t) => ({ answer: t.answer + 'Hel' }));
    store.updateTurn(conversationId, turnId, (t) => ({ answer: t.answer + 'lo' }));
    expect(JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)!).conversations[0].turns[0].answer).toBe('');
    store.updateTurn(conversationId, turnId, { status: 'done' }, true);
    expect(JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)!).conversations[0].turns[0]).toMatchObject({ answer: 'Hello', status: 'done' });
  });

  it('a page closed mid-answer reads back as stopped', () => {
    const store = useConversations.getState();
    const { conversationId, turnId } = store.startTurn({ action: 'ask', question: 'Q' }, 'Q');
    store.updateTurn(conversationId, turnId, { answer: 'Part' }, true);
    expect(loadStored().conversations[0].turns[0]).toMatchObject({ status: 'stopped', answer: 'Part' });
  });

  it('sends answered turns as history, with their sources', () => {
    const store = useConversations.getState();
    const a = store.startTurn({ action: 'ask', question: 'One' }, 'One');
    store.updateTurn(a.conversationId, a.turnId, { status: 'done', answer: 'First', sources: [{ path: 'A.md', chars: 5, truncated: false }] }, true);
    const b = store.startTurn({ action: 'ask', question: 'Two' }, 'Two');
    store.updateTurn(b.conversationId, b.turnId, { status: 'error', error: 'boom' }, true);
    const c = store.startTurn({ action: 'summarize', scope: 'note', path: 'B.md' }, 'Summarize B');
    expect(historyOf(currentConversation(), c.turnId)).toEqual([{ prompt: { action: 'ask', question: 'One' }, answer: 'First', sources: ['A.md'] }]);
  });

  it('a new conversation starts with the next question; old ones can be reopened or deleted', () => {
    const store = useConversations.getState();
    const first = store.startTurn({ action: 'ask', question: 'One' }, 'One');
    store.newConversation();
    expect(currentConversation()).toBeNull();
    const second = store.startTurn({ action: 'ask', question: 'Two' }, 'Two');
    expect(second.conversationId).not.toBe(first.conversationId);
    store.select(first.conversationId);
    expect(currentConversation()?.title).toBe('One');
    store.remove(first.conversationId);
    expect(useConversations.getState().conversations.map((c) => c.id)).toEqual([second.conversationId]);
    expect(currentConversation()).toBeNull();
  });

  it('keeps only the newest conversations', () => {
    const many: Conversation[] = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_, i) => ({ id: `c${i}`, title: `${i}`, createdAt: i, updatedAt: i, turns: [] }));
    const kept = trimForStorage(many);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept[0].id).toBe(`c${MAX_CONVERSATIONS + 4}`);
  });

  it('ignores a damaged store', () => {
    localStorage.setItem(CONVERSATIONS_KEY, '{nope');
    expect(loadStored().conversations).toEqual([]);
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify({ version: 1, currentId: 'x', conversations: [{ id: 'x', turns: [{ id: 1 }] }] }));
    expect(loadStored().conversations[0].turns).toEqual([]);
  });
});
