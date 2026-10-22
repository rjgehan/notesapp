// Conversations with Claude, kept per device in localStorage (ROADMAP item 18, DESIGN §6.31): the
// server keeps none. Each turn stores what was asked (as sent, so follow-ups can send it back), the
// answer and the notes that went with it; a follow-up sends the earlier turns as `history`.
import { create } from 'zustand';
import type { AiPrompt, AiSource, AiTurn } from '../../api/types';
import { vaultKey } from '../../state/vault';

export const CONVERSATIONS_KEY = 'notesapp:ai:conversations';

/** Older conversations are dropped beyond these limits, so localStorage never fills up. */
export const MAX_CONVERSATIONS = 30;
export const MAX_TURNS = 40;
export const MAX_STORED_CHARS = 1_500_000;

export type TurnStatus = 'streaming' | 'done' | 'error' | 'stopped';

export interface StoredTurn {
  id: string;
  /** As sent to the server; sent back in `history` by later turns. */
  prompt: AiPrompt;
  /** What the user's side of the turn shows. */
  label: string;
  answer: string;
  sources: AiSource[];
  omitted: number;
  excluded: number;
  status: TurnStatus;
  error: string | null;
  model: string | null;
  stopReason: string | null;
  costUsd: number | null;
  at: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

interface Stored {
  version: 1;
  currentId: string | null;
  conversations: Conversation[];
}

interface ConversationsState {
  conversations: Conversation[];
  currentId: string | null;
  /** Starts a turn in the current conversation (a new one when there is none) and returns its id. */
  startTurn(prompt: AiPrompt, label: string): { conversationId: string; turnId: string };
  updateTurn(conversationId: string, turnId: string, patch: Partial<StoredTurn> | ((t: StoredTurn) => Partial<StoredTurn>), persist?: boolean): void;
  newConversation(): void;
  select(id: string): void;
  remove(id: string): void;
  clearAll(): void;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function titleOf(label: string): string {
  const line = label.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 59) + '…' : line || 'New conversation';
}

function isTurn(t: unknown): t is StoredTurn {
  if (!t || typeof t !== 'object') return false;
  const v = t as Partial<StoredTurn>;
  return typeof v.id === 'string' && typeof v.answer === 'string' && typeof v.label === 'string' && !!v.prompt && typeof v.prompt === 'object' && Array.isArray(v.sources);
}

export function loadStored(): Stored {
  const empty: Stored = { version: 1, currentId: null, conversations: [] };
  try {
    const raw = localStorage.getItem(vaultKey(CONVERSATIONS_KEY));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) return empty;
    const conversations = parsed.conversations
      .filter((c): c is Conversation => !!c && typeof c.id === 'string' && Array.isArray(c.turns))
      .map((c) => ({
        ...c,
        // A page closed mid-answer left a turn streaming: it was cut off.
        turns: c.turns.filter(isTurn).map((t) => (t.status === 'streaming' ? { ...t, status: 'stopped' as const } : t)),
      }));
    const currentId = conversations.some((c) => c.id === parsed.currentId) ? (parsed.currentId ?? null) : null;
    return { version: 1, currentId, conversations };
  } catch {
    return empty;
  }
}

/** Keeps the newest conversations within the count and size limits. */
export function trimForStorage(conversations: Conversation[]): Conversation[] {
  let kept = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  kept = kept.map((c) => (c.turns.length > MAX_TURNS ? { ...c, turns: c.turns.slice(-MAX_TURNS) } : c));
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_STORED_CHARS) kept = kept.slice(0, -1);
  return kept;
}

function save(state: { conversations: Conversation[]; currentId: string | null }): Conversation[] {
  const conversations = trimForStorage(state.conversations);
  try {
    const stored: Stored = { version: 1, currentId: state.currentId, conversations };
    localStorage.setItem(vaultKey(CONVERSATIONS_KEY), JSON.stringify(stored));
  } catch {
    // Private mode or quota: the conversation still works for this page load.
  }
  return conversations;
}

const initial = loadStored();

export const useConversations = create<ConversationsState>()((set, get) => ({
  conversations: initial.conversations,
  currentId: initial.currentId,

  startTurn(prompt, label) {
    const now = Date.now();
    const turn: StoredTurn = {
      id: newId(),
      prompt,
      label,
      answer: '',
      sources: [],
      omitted: 0,
      excluded: 0,
      status: 'streaming',
      error: null,
      model: null,
      stopReason: null,
      costUsd: null,
      at: now,
    };
    let { conversations, currentId } = get();
    let conversation = conversations.find((c) => c.id === currentId);
    if (!conversation) {
      conversation = { id: newId(), title: titleOf(label), createdAt: now, updatedAt: now, turns: [] };
      conversations = [conversation, ...conversations];
      currentId = conversation.id;
    }
    const id = conversation.id;
    conversations = conversations.map((c) => (c.id === id ? { ...c, updatedAt: now, turns: [...c.turns, turn] } : c));
    set({ conversations: save({ conversations, currentId }), currentId });
    return { conversationId: id, turnId: turn.id };
  },

  updateTurn(conversationId, turnId, patch, persist = false) {
    const conversations = get().conversations.map((c) => {
      if (c.id !== conversationId) return c;
      return {
        ...c,
        updatedAt: Date.now(),
        turns: c.turns.map((t) => (t.id === turnId ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)),
      };
    });
    if (persist) set({ conversations: save({ conversations, currentId: get().currentId }) });
    else set({ conversations });
  },

  newConversation() {
    const { conversations } = get();
    set({ conversations: save({ conversations, currentId: null }), currentId: null });
  },

  select(id) {
    const { conversations } = get();
    if (!conversations.some((c) => c.id === id)) return;
    set({ conversations: save({ conversations, currentId: id }), currentId: id });
  },

  remove(id) {
    const { conversations, currentId } = get();
    const rest = conversations.filter((c) => c.id !== id);
    const next = currentId === id ? null : currentId;
    set({ conversations: save({ conversations: rest, currentId: next }), currentId: next });
  },

  clearAll() {
    set({ conversations: save({ conversations: [], currentId: null }), currentId: null });
  },
}));

export function currentConversation(state: Pick<ConversationsState, 'conversations' | 'currentId'> = useConversations.getState()): Conversation | null {
  return state.conversations.find((c) => c.id === state.currentId) ?? null;
}

/**
 * The finished turns of a conversation as `history` (API.md §24.1): answered turns only, oldest
 * first, the turn being asked left out. A stopped answer goes along as far as it got.
 */
export function historyOf(conversation: Conversation | null, exceptTurnId?: string): AiTurn[] {
  if (!conversation) return [];
  return conversation.turns
    .filter((t) => t.id !== exceptTurnId && (t.status === 'done' || (t.status === 'stopped' && t.answer !== '')))
    .slice(-12)
    .map((t) => ({ prompt: t.prompt, answer: t.answer, sources: t.sources.map((s) => s.path) }));
}
