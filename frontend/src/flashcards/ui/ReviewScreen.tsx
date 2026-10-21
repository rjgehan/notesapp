// A review session (DESIGN §6.34): one card at a time, phone first. The answer buttons sit at the
// bottom within reach of the thumb; a tap on the card shows the answer. On a keyboard: Space or
// Enter shows the answer and then answers Good, 1–4 answer Again, Hard, Good, Easy, U (or Mod-Z)
// undoes, E opens the note, S skips and Escape ends the session.
import { ChevronLeft, CircleCheck, FilePenLine, MoreHorizontal, RotateCcw, SkipForward, Undo2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu } from '../../components/overlays/ContextMenu';
import { navigateTo } from '../../features/navigation';
import { noteRoute, displayName } from '../../features/paths';
import { modKey } from '../../features/platform';
import { useUi } from '../../state/ui';
import { doneToday, inDeck, studyDay, type StudyItem } from '../deck';
import { ANSWERS, formatInterval, preview, step, toState, type Answer } from '../schedule';
import type { Scope } from '../routes';
import { answer, buildQueue, pickNext, refresh, remaining, reveal, skip, startSession, toReview, undo, waitingUntil } from '../session';
import { outbox } from '../store';
import type { FlashcardData } from '../useFlashcards';
import { CardFace } from './CardFace';

const LABELS: Record<Answer, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };

function inScope(item: StudyItem, scope: Scope): boolean {
  if (scope.note) return item.card.path === scope.note;
  return scope.deck === null || inDeck(item, scope.deck);
}

function scopeLabel(scope: Scope): string {
  if (scope.note) return displayName(scope.note);
  if (scope.deck === null) return 'All decks';
  return scope.deck === '' ? 'Vault root' : scope.deck;
}

export function ReviewScreen({ data, scope, onExit }: { data: FlashcardData; scope: Scope; onExit(): void }) {
  const config = data.config!;
  const f = data.scheduler!;
  const [startedAt] = useState(() => Date.now());
  const day = useMemo(() => studyDay(startedAt, config), [startedAt, config]);
  const [session, setSession] = useState(() => {
    const scoped = data.items.filter((i) => inScope(i, scope));
    const done = doneToday(data.records, day.start);
    const limits = scope.note
      ? { newLeft: Infinity, reviewLeft: Infinity }
      : { newLeft: config.newPerDay - done.newCards, reviewLeft: config.reviewsPerDay - done.reviews };
    return startSession(buildQueue(scoped, startedAt, day.end, limits), startedAt);
  });
  const [total] = useState(() => session.queue.length + (session.current ? 1 : 0));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Answers on other devices and edited notes reach the queue when the next card is picked.
  const itemsRef = useRef(new Map<string, StudyItem>());
  useEffect(() => {
    itemsRef.current = new Map(data.items.filter((i) => inScope(i, scope)).map((i) => [i.card.id, i]));
  }, [data.items, scope]);

  const current = session.current;
  const intervals = useMemo(() => (current ? preview(f, current.fsrs, session.shownAt) : null), [f, current, session.shownAt]);
  const left = remaining(session, session.shownAt, day.end);
  const waitUntil = waitingUntil(session);

  // A learning card waiting for its time comes back by itself.
  useEffect(() => {
    if (waitUntil === null) return;
    const timer = window.setTimeout(() => setSession((s) => pickNext(s, Date.now())), Math.max(0, waitUntil - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [waitUntil]);

  const actions = {
    reveal: () => setSession((s) => reveal(s)),
    answer: (rating: Answer) => {
      if (!session.current) return;
      const now = Date.now();
      const r = answer(reveal(refresh(session, itemsRef.current, now, day.end)), rating, now, f, day.end);
      if (!r) return;
      setSession(r.state);
      outbox()?.add({ kind: 'review', review: toReview(r.answered) });
    },
    undo: () => {
      const u = undo(session, Date.now());
      if (!u) return;
      setSession(u.state);
      const { item, review } = u.undone;
      outbox()?.undo(item.card.id, new Date(review.at).toISOString(), item.fsrs ? toState(item.fsrs, item.answers) : undefined);
    },
    skip: () => setSession((s) => skip(s, Date.now())),
    reset: () => {
      const item = session.current;
      if (!item) return;
      const now = Date.now();
      const after = step(f, item.fsrs, { at: now, rating: 'reset', ms: null });
      outbox()?.add({
        kind: 'review',
        review: { card: item.card.id, at: new Date(now).toISOString(), rating: 'reset', note: item.card.path, front: item.card.hint, state: toState(after, item.answers + 1), ...(item.from ? { from: item.from } : {}) },
      });
      setSession((s) => skip(s, now));
    },
    edit: () => {
      const item = session.current;
      if (item) navigateTo(noteRoute(item.card.path) + '?line=' + item.card.line);
    },
    showNow: () => setSession((s) => pickNext(s, waitUntil ?? Date.now())),
  };
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });
  const revealedRef = useRef(session.revealed);
  const hasCardRef = useRef(current !== null);
  useLayoutEffect(() => {
    revealedRef.current = session.revealed;
    hasCardRef.current = current !== null;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (e.defaultPrevented || useUi.getState().overlay !== null) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="menu"], [role="dialog"]'))) return;
      const a = actionsRef.current;
      if (modKey(e) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        a.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        onExit();
      } else if (key === 'u') a.undo();
      else if (!hasCardRef.current) return;
      else if (key === ' ' || key === 'enter') {
        e.preventDefault();
        if (revealedRef.current) a.answer('good');
        else a.reveal();
      } else if (/^[1-4]$/.test(key) && revealedRef.current) {
        e.preventDefault();
        a.answer(ANSWERS[Number(key) - 1]);
      } else if (key === 'e') a.edit();
      else if (key === 's') a.skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const done = session.answered.length;
  const progress = total > 0 ? Math.min(1, done / Math.max(total, done + left.new + left.learning + left.review)) : 1;

  return (
    <div className="fc-review">
      <div className="fc-review-bar">
        <button type="button" className="icon-button fc-bar-button" aria-label="End review" title="End review (Esc)" onClick={onExit}>
          <ChevronLeft size={20} aria-hidden />
        </button>
        <div className="fc-review-title">
          <span className="fc-review-scope">{scopeLabel(scope)}</span>
          <span className="fc-counts" aria-label={`${left.new} new, ${left.learning} learning, ${left.review} to review`}>
            <span className="fc-count is-new">{left.new}</span>
            <span className="fc-count is-learning">{left.learning}</span>
            <span className="fc-count is-review">{left.review}</span>
          </span>
        </div>
        <button type="button" className="icon-button fc-bar-button" aria-label="Undo last answer" title="Undo (U)" disabled={done === 0} onClick={actions.undo}>
          <Undo2 size={20} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-button fc-bar-button"
          aria-label="More"
          aria-haspopup="menu"
          disabled={!current}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.bottom });
          }}
        >
          <MoreHorizontal size={20} aria-hidden />
        </button>
      </div>
      <div className="fc-progress" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <div className="fc-progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      {current ? (
        <>
          <div
            className={`fc-review-body${session.revealed ? ' is-revealed' : ''}`}
            onClick={() => {
              if (!session.revealed && !window.getSelection()?.toString()) actions.reveal();
            }}
          >
            <div className="fc-card" key={current.card.id + ':' + session.shownAt}>
              {current.card.context.some(Boolean) && <div className="fc-context">{current.card.context.filter(Boolean).join(' › ')}</div>}
              {current.card.kind === 'cloze' && session.revealed ? (
                <CardFace markdown={current.card.back} path={current.card.path} />
              ) : (
                <CardFace markdown={current.card.front} path={current.card.path} />
              )}
              {session.revealed && current.card.kind !== 'cloze' && (
                <>
                  <hr className="fc-divider" />
                  <CardFace markdown={current.card.back} path={current.card.path} className="fc-answer" />
                </>
              )}
              <div className="fc-source">
                {current.fsrs === null ? 'New card' : current.card.kind === 'reverse' ? 'Reverse card' : null}
                <button type="button" className="link-button" onClick={(e) => (e.stopPropagation(), actions.edit())}>
                  {displayName(current.card.path)}
                </button>
              </div>
            </div>
          </div>
          <div className="fc-actions">
            {!session.revealed ? (
              <button type="button" className="fc-show" onClick={actions.reveal}>
                Show answer
              </button>
            ) : (
              <div className="fc-answers" role="group" aria-label="How well did you remember?">
                {ANSWERS.map((a, i) => (
                  <button key={a} type="button" className={`fc-answer-button is-${a}`} onClick={() => actions.answer(a)} title={`${LABELS[a]} (${i + 1})`}>
                    <span className="fc-answer-interval">{intervals ? formatInterval(intervals[a].interval) : ''}</span>
                    <span className="fc-answer-label">{LABELS[a]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : waitUntil !== null ? (
        <Waiting until={waitUntil} onShowNow={actions.showNow} />
      ) : (
        <Finished session={session} onExit={onExit} />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Card"
          onClose={() => setMenu(null)}
          items={[
            { id: 'edit', label: 'Edit in note', icon: <FilePenLine size={16} aria-hidden />, run: actions.edit },
            { id: 'skip', label: 'Skip for now', icon: <SkipForward size={16} aria-hidden />, run: actions.skip },
            { id: 'reset', label: 'Reset progress', icon: <RotateCcw size={16} aria-hidden />, run: actions.reset, danger: true },
          ]}
        />
      )}
    </div>
  );
}

function Waiting({ until, onShowNow }: { until: number; onShowNow(): void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="fc-finished">
      <p className="fc-finished-title">Next card in {formatInterval(Math.max(60_000, until - now))}</p>
      <p className="muted">A card you are still learning comes back soon. It shows here by itself.</p>
      <button type="button" className="button" onClick={onShowNow}>
        Show it now
      </button>
    </div>
  );
}

function Finished({ session, onExit }: { session: ReturnType<typeof startSession>; onExit(): void }) {
  const answered = session.answered;
  const again = answered.filter((a) => a.review.rating === 'again').length;
  const ms = answered.reduce((sum, a) => sum + (a.review.ms ?? 0), 0);
  const cards = new Set(answered.map((a) => a.item.card.id)).size;
  return (
    <div className="fc-finished" role="status">
      <CircleCheck size={40} className="fc-finished-icon" aria-hidden />
      <p className="fc-finished-title">{answered.length ? 'Done for now' : 'Nothing to review'}</p>
      {answered.length > 0 ? (
        <p className="muted">
          {cards} {cards === 1 ? 'card' : 'cards'} in {Math.max(1, Math.round(ms / 60_000))} min
          {again > 0 ? ` · ${again} again` : ''}
        </p>
      ) : (
        <p className="muted">No cards are due here. New cards come in as the daily limit allows.</p>
      )}
      <button type="button" className="button button-primary fc-finished-button" onClick={onExit}>
        Back to decks
      </button>
    </div>
  );
}
