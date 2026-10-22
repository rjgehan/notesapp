// Asking and summarizing (ROADMAP item 18): adds a turn to the current conversation, streams the
// answer into it, and keeps the per-device history. Several answers may stream at once (one per
// conversation turn); Stop aborts the request, which also stops the answer on the server.
import { ApiError, TransientError, errorMessage } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import type { AiPrompt, AiSummarizeRequest } from '../../api/types';
import { streamAi, type AiRequest } from './aiClient';
import { currentConversation, historyOf, useConversations } from './conversations';

export const AI_STATUS_KEY = ['ai', 'status'] as const;

const controllers = new Map<string, AbortController>();

/** User-facing text for a refused or failed request. */
export function aiErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const p = e.problem;
    switch (p.code) {
      case 'ai-unavailable':
        return p.reason === 'off' ? 'Ask and summaries are switched off. Turn them on in Settings › Ask and summaries.' : (p.detail ?? 'Ask and summaries are unavailable.');
      case 'ai-excluded':
        return 'That is in a folder excluded from Ask and summaries, so it is never sent (Settings › Ask and summaries).';
      case 'ai-budget-exceeded':
        return `${p.detail ?? 'This month’s budget is reached.'} Raise it in Settings › Ask and summaries, or wait for next month.`;
      case 'not-found':
        return `Not found: ${p.path ?? 'that note'}`;
      default:
        return errorMessage(e);
    }
  }
  if (e instanceof TransientError) return e.message === 'The answer was cut off' ? 'The answer was cut off (the connection dropped).' : 'Could not reach the server.';
  return e instanceof Error ? e.message : String(e);
}

function run(request: AiRequest, prompt: AiPrompt, label: string): string {
  const store = useConversations.getState();
  const history = historyOf(currentConversation());
  const { conversationId, turnId } = store.startTurn(prompt, label);
  const body = { ...request.body, history } as typeof request.body;
  const controller = new AbortController();
  controllers.set(turnId, controller);
  const update = useConversations.getState().updateTurn;
  void streamAi({ url: request.url, body } as AiRequest, {
    start: (s) => update(conversationId, turnId, { sources: s.sources, omitted: s.omitted, excluded: s.excluded, model: s.model }),
    delta: (d) => update(conversationId, turnId, (t) => ({ answer: t.answer + d.text })),
    restart: (r) => update(conversationId, turnId, { answer: '', model: r.model }),
    done: (d) => {
      update(conversationId, turnId, { status: 'done', model: d.model, stopReason: d.stopReason, costUsd: d.costUsd }, true);
      void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
    error: (e) => update(conversationId, turnId, { status: 'error', error: e.message }, true),
  }, controller.signal)
    .catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') {
        update(conversationId, turnId, { status: 'stopped' }, true);
        void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
        return;
      }
      update(conversationId, turnId, { status: 'error', error: aiErrorText(e) }, true);
      if (e instanceof ApiError) void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
    })
    .finally(() => controllers.delete(turnId));
  return turnId;
}

/** Asks a question about the vault; `activePath` (the open note) is sent first when given. */
export function askQuestion(question: string, activePath: string | null): string {
  const q = question.trim();
  return run({ url: '/api/ai/ask', body: { question: q, activePath } }, { action: 'ask', question: q }, q);
}

/** Summarizes a note, folder, list of notes or selection, or suggests links, tags and tasks. */
export function summarize(request: Omit<AiSummarizeRequest, 'history'>, label: string): string {
  const prompt: AiPrompt = {
    action: request.action ?? 'summarize',
    scope: request.scope,
    path: request.path ?? null,
    paths: request.paths ?? null,
    text: request.text ?? null,
    label: request.label ?? null,
  };
  return run({ url: '/api/ai/summarize', body: { ...request } }, prompt, label);
}

export function stopTurn(turnId: string): void {
  controllers.get(turnId)?.abort();
}

export function isStreaming(turnId: string): boolean {
  return controllers.has(turnId);
}
