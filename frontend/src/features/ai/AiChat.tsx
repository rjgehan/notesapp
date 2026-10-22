// The conversation view of Ask your vault (ROADMAP item 18, DESIGN §6.31), shared by the right
// panel (the bottom sheet on phones) and the page /x/ask. Questions and the notes they use go to
// Anthropic only when the user asks; the view says so before the first question and in its footer.
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Copy, FolderOpen, History, Lightbulb, MessageSquarePlus, Send, Settings as SettingsIcon, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { useTree, useVaultSettings } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import type { AiStatus } from '../../api/types';
import { useAutoGrow, autoGrow } from '../../components/autoGrow';
import { useWorkspaceScroller } from '../../components/layout/workspaceScroller';
import { formatRelative } from '../format';
import { openPath } from '../navigation';
import { displayName, isNotePath } from '../paths';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';
import { canSummarizeNote, folderOfNote, suggestForNote, summarizeFolder, summarizeNote, summarizeWeek } from './actions';
import { AiAnswer } from './AiAnswer';
import { fetchAiStatus } from './aiClient';
import { useConversations, type StoredTurn } from './conversations';
import { AI_STATUS_KEY, askQuestion, stopTurn } from './run';
import './ai.css';

export const NOTICE_KEY = 'notesapp:ai:noticeSeen';

function noticeSeen(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Settings › Ask and summaries; closes the sheet (phones and tablets) so the page is seen. */
function SettingsLink() {
  return (
    <Link className="button button-small" to="/settings/ai" onClick={() => useUi.getState().setSheetOpen(false)}>
      <SettingsIcon size={13} aria-hidden /> Settings
    </Link>
  );
}

function Unavailable({ status }: { status: AiStatus }) {
  if (status.state === 'off') {
    return (
      <div className="ai-unavailable">
        <p>
          <strong>Ask and summaries are off.</strong> When they are on, your questions and the text of the notes they need are sent to Anthropic’s Claude API to write the answer.
        </p>
        <SettingsLink />
      </div>
    );
  }
  if (status.state === 'not-configured') {
    return (
      <div className="ai-unavailable">
        <p>
          <strong>{status.provider === 'api' ? 'The server cannot use the Anthropic API.' : 'The server cannot use Claude Code.'}</strong> {status.reason}. {status.provider === 'api' ? 'Put an API key in' : 'Put a Claude Code token (made with claude setup-token) in'} the server’s <code>{status.keyFile}</code> file (CASAOS.md or DEPLOY.md, “Ask your vault”).
        </p>
      </div>
    );
  }
  return (
    <div className="ai-unavailable">
      <p>
        <strong>This month’s budget is used up.</strong> {status.reason}.
      </p>
      <SettingsLink />
    </div>
  );
}

function Turn({ turn, onOpen }: { turn: StoredTurn; onOpen?(): void }) {
  const streaming = turn.status === 'streaming';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.answer);
      toast('Copied the answer');
    } catch {
      toast('The browser refused clipboard access', { kind: 'error' });
    }
  };
  return (
    <li className={`ai-turn is-${turn.status}`}>
      <AiAnswer className="ai-question" text={turn.label} onOpen={onOpen} />
      <div className="ai-reply" aria-live={streaming ? 'polite' : undefined} aria-busy={streaming}>
        {turn.answer !== '' && <AiAnswer text={turn.answer} onOpen={onOpen} />}
        {streaming && turn.answer === '' && <p className="ai-thinking">Thinking…</p>}
        {turn.stopReason === 'max_tokens' && <p className="ai-note">The answer reached the length limit and stops here.</p>}
        {turn.stopReason === 'refusal' && <p className="ai-note">Claude declined to answer this. Try rephrasing it.</p>}
        {turn.status === 'stopped' && <p className="ai-note">Stopped.</p>}
        {turn.status === 'error' && (
          <p className="ai-error" role="alert">
            <TriangleAlert size={13} aria-hidden /> {turn.error}
          </p>
        )}
      </div>
      {(turn.sources.length > 0 || turn.excluded > 0 || turn.omitted > 0) && (
        <details className="ai-sources">
          <summary>
            {turn.sources.length === 1 ? '1 note sent' : `${turn.sources.length} notes sent`}
            {turn.excluded > 0 && ` · ${turn.excluded} excluded`}
            {turn.omitted > 0 && ` · ${turn.omitted} did not fit`}
          </summary>
          <ul>
            {turn.sources.map((s) => (
              <li key={s.path}>
                <button
                  type="button"
                  className="ai-source"
                  title={s.path}
                  onClick={() => {
                    useUi.getState().setSheetOpen(false);
                    openPath(s.path);
                    onOpen?.();
                  }}
                >
                  {displayName(s.path)}
                  {s.truncated && <span className="muted"> (excerpt)</span>}
                </button>
              </li>
            ))}
          </ul>
          {turn.excluded > 0 && <p className="muted">Notes in excluded folders matched but were not sent.</p>}
        </details>
      )}
      {!streaming && turn.status !== 'error' && turn.answer !== '' && (
        <div className="ai-turn-meta">
          <span className="muted">
            {turn.model ?? ''}
            {turn.costUsd !== null && ` · ${money(turn.costUsd)}`}
          </span>
          <button type="button" className="icon-button ai-small-button" aria-label="Copy the answer" title="Copy the answer" onClick={() => void copy()}>
            <Copy size={14} />
          </button>
        </div>
      )}
      {streaming && (
        <div className="ai-turn-meta">
          <button type="button" className="button button-small" onClick={() => stopTurn(turn.id)}>
            <Square size={12} aria-hidden /> Stop
          </button>
        </div>
      )}
    </li>
  );
}

function Conversations({ onClose }: { onClose(): void }) {
  const { conversations, currentId, select, remove, clearAll } = useConversations();
  if (conversations.length === 0) return <p className="panel-empty">No conversations on this device yet.</p>;
  return (
    <div className="ai-history">
      <ul>
        {conversations.map((c) => (
          <li key={c.id} className={c.id === currentId ? 'is-current' : undefined}>
            <button
              type="button"
              className="ai-history-item"
              onClick={() => {
                select(c.id);
                onClose();
              }}
            >
              <span className="ai-history-title">{c.title}</span>
              <span className="muted">{formatRelative(c.updatedAt)}</span>
            </button>
            <button type="button" className="icon-button ai-small-button" aria-label={`Delete “${c.title}”`} title="Delete" onClick={() => remove(c.id)}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="button button-small" onClick={clearAll}>
        Delete all conversations on this device
      </button>
    </div>
  );
}

interface Props {
  /** The open note: sent first with a question when “Include” is on, and the target of the quick actions. */
  activePath: string | null;
  variant: 'panel' | 'page';
  onOpen?(): void;
}

export function AiChat({ activePath, variant, onOpen }: Props) {
  const settings = useVaultSettings();
  const tree = useTree().data;
  const status = useQuery({ queryKey: AI_STATUS_KEY, queryFn: fetchAiStatus, staleTime: 30_000 });
  const { conversations, currentId, newConversation } = useConversations();
  const conversation = conversations.find((c) => c.id === currentId) ?? null;
  const [text, setText] = useState('');
  const [includeNote, setIncludeNote] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [notice, setNotice] = useState(noticeSeen);
  const input = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const workspace = useWorkspaceScroller();
  useAutoGrow(input);

  // The status follows the settings (on, off, budget, model) without waiting for its stale time.
  const aiSettings = JSON.stringify(settings.ai ?? null);
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AI_STATUS_KEY });
  }, [aiSettings]);

  const turns = conversation?.turns ?? [];
  const last = turns[turns.length - 1];
  const streaming = turns.some((t) => t.status === 'streaming');
  const ready = status.data?.state === 'ready';
  const note = activePath !== null && isNotePath(activePath) && tree?.byPath.has(activePath) ? activePath : null;
  const folder = folderOfNote(note);

  // The panel scrolls its messages; the page scrolls with the workspace, its only scroller (§6.16).
  const scroller = useCallback(() => (variant === 'page' ? workspace.current : messages.current), [variant, workspace]);
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller, showHistory]);

  // Follow the answer as it streams, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller();
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last?.answer, turns.length, scroller, ready]);

  const acknowledge = () => {
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      // Shown again next time; harmless.
    }
    setNotice(true);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || !ready) return;
    if (!notice) acknowledge();
    askQuestion(q, includeNote ? note : null);
    setText('');
    atBottom.current = true;
    requestAnimationFrame(() => {
      if (input.current) autoGrow(input.current);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const quick = (run: () => void) => () => {
    if (!notice) acknowledge();
    atBottom.current = true;
    run();
  };

  return (
    <div className={`ai-chat is-${variant}`}>
      <div className="ai-toolbar">
        <span className="ai-title" title={conversation?.title ?? 'New conversation'}>
          {showHistory ? 'Conversations on this device' : (conversation?.title ?? 'New conversation')}
        </span>
        <button type="button" className={`icon-button ai-small-button${showHistory ? ' is-active' : ''}`} aria-label="Conversations" title="Conversations on this device" aria-pressed={showHistory} onClick={() => setShowHistory((v) => !v)}>
          <History size={16} />
        </button>
        <button
          type="button"
          className="icon-button ai-small-button"
          aria-label="New conversation"
          title="New conversation"
          disabled={streaming}
          onClick={() => {
            newConversation();
            setShowHistory(false);
            input.current?.focus();
          }}
        >
          <MessageSquarePlus size={16} />
        </button>
      </div>

      {showHistory ? (
        <Conversations onClose={() => setShowHistory(false)} />
      ) : (
        <div className="ai-messages" ref={messages}>
          {status.isError && <p className="ai-error">{errorMessage(status.error)}</p>}
          {status.data && !ready && <Unavailable status={status.data} />}
          {ready && !notice && (
            <div className="ai-notice" role="note">
              <p>
                <Sparkles size={14} aria-hidden /> Answers are written by Claude. <strong>Your question and the text of the notes it needs are sent to Anthropic</strong> when you ask; notes in excluded folders ({(settings.ai?.excludedPaths ?? []).join(', ') || 'none set'}) never are.
              </p>
              <button type="button" className="button button-small" onClick={acknowledge}>
                Got it
              </button>
            </div>
          )}
          {turns.length === 0 && ready && (
            <p className="ai-empty">Ask about anything in your notes. Answers cite the notes they come from; tap a citation to open it.</p>
          )}
          <ol className="ai-turns">
            {turns.map((t) => (
              <Turn key={t.id} turn={t} onOpen={onOpen} />
            ))}
          </ol>
        </div>
      )}

      {!showHistory && ready && !streaming && (
        <div className="ai-quick" role="group" aria-label="Quick actions">
          {note && canSummarizeNote(note) && (
            <button type="button" className="ai-chip" onClick={quick(() => summarizeNote(note))}>
              <Sparkles size={13} aria-hidden /> Summarize this note
            </button>
          )}
          {note && (
            <button type="button" className="ai-chip" onClick={quick(() => suggestForNote(note))}>
              <Lightbulb size={13} aria-hidden /> Links, tags, tasks
            </button>
          )}
          {folder && (
            <button type="button" className="ai-chip" onClick={quick(() => summarizeFolder(folder))}>
              <FolderOpen size={13} aria-hidden /> This folder
            </button>
          )}
          <button
            type="button"
            className="ai-chip"
            onClick={quick(() => {
              if (!summarizeWeek()) toast('There is no daily note this week yet');
            })}
          >
            <CalendarRange size={13} aria-hidden /> This week
          </button>
        </div>
      )}

      {!showHistory && (
        <form className="ai-composer" onSubmit={submit}>
          {note && (
            <label className="ai-include">
              <input type="checkbox" checked={includeNote} onChange={(e) => setIncludeNote(e.target.checked)} disabled={!ready} />
              Include “{displayName(note)}”
            </label>
          )}
          <div className="ai-input-row">
            <textarea
              ref={input}
              className="text-input ai-input"
              rows={1}
              value={text}
              placeholder={ready ? 'Ask your notes…' : 'Not available'}
              aria-label="Question about your notes"
              disabled={!ready}
              enterKeyHint="send"
              onChange={(e) => {
                setText(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={onKeyDown}
            />
            <button type="submit" className="icon-button ai-send" aria-label="Ask" title="Ask (Enter)" disabled={!ready || text.trim() === ''}>
              <Send size={17} />
            </button>
          </div>
          {status.data && (
            <p className="ai-footnote">
              {status.data.fake ? 'Fake answers (development server)' : status.data.provider === 'api' ? 'Sent to the Anthropic API when you ask' : 'Sent to Claude with your subscription when you ask'} · {status.data.models.find((m) => m.id === status.data.model)?.label ?? status.data.model} · {money(status.data.monthCostUsd)} of {money(status.data.monthlyBudgetUsd)} this month
            </p>
          )}
        </form>
      )}
    </div>
  );
}
