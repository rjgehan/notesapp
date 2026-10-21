// Flashcard statistics (DESIGN §6.34): today, the cards by stage, answers per day, the forecast,
// retention and the streak. Charts are single-series bars in the accent colour, with a value
// shown for the bar under the pointer or focus.
import { useMemo, useState } from 'react';
import { toastError } from '../../features/errors';
import { confirmAction } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { orphanRecords } from '../deck';
import { computeStats, type Stats } from '../stats';
import { flashcardApi } from '../api';
import { applyWriteResult } from '../store';
import { queryClient } from '../../api/queryClient';
import type { FlashcardData } from '../useFlashcards';

const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

function minutes(ms: number): string {
  if (ms > 0 && ms < 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function BarChart({ title, bars, empty }: { title: string; bars: { label: string; value: number }[]; empty: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const total = bars.reduce((sum, b) => sum + b.value, 0);
  const shown = active !== null ? bars[active] : null;
  return (
    <section className="status-card fc-chart-card">
      <h2 className="status-card-title">{title}</h2>
      <p className="fc-chart-readout" aria-live="polite">
        {shown ? (
          <>
            <strong>{shown.value}</strong> · {shown.label}
          </>
        ) : total ? (
          <>
            <strong>{total}</strong> in all · up to {max} a day
          </>
        ) : (
          empty
        )}
      </p>
      <div className="fc-chart" role="list" aria-label={title} onPointerLeave={() => setActive(null)}>
        {bars.map((b, i) => (
          <div
            key={i}
            role="listitem"
            tabIndex={0}
            className={`fc-bar${active === i ? ' is-active' : ''}`}
            aria-label={`${b.label}: ${b.value}`}
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <div className="fc-bar-fill" style={{ height: `${(b.value / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="fc-chart-axis" aria-hidden>
        <span>{bars[0]?.label}</span>
        <span>{bars[bars.length - 1]?.label}</span>
      </div>
    </section>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="fc-tile">
      <div className="fc-tile-value">{value}</div>
      <div className="fc-tile-label">{label}</div>
      {detail && <div className="fc-tile-detail">{detail}</div>}
    </div>
  );
}

export function StatsView({ data, now }: { data: FlashcardData; now: number }) {
  const config = data.config!;
  const stats: Stats = useMemo(() => computeStats(data.records, data.items, now, config.dayStartsAt), [data.records, data.items, now, config.dayStartsAt]);
  const orphans = useMemo(() => orphanRecords(data.items, data.records), [data.items, data.records]);
  const history = stats.history.map((d, i) => ({ label: i === stats.history.length - 1 ? 'Today' : dayLabel(d.day), value: d.count }));
  const forecast = stats.forecast.map((value, i) => {
    const d = new Date(stats.history[stats.history.length - 1].day);
    d.setDate(d.getDate() + i);
    return { label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(d.getTime()), value };
  });

  const forget = async () => {
    const ok = await confirmAction({
      title: 'Forget old review data?',
      message: `${orphans.length} review ${orphans.length === 1 ? 'record belongs' : 'records belong'} to cards that are in no note any more (deleted, or edited beyond recognition). Their history stays in the vault's git history.`,
      confirmLabel: 'Forget',
      danger: true,
    });
    if (!ok) return;
    try {
      applyWriteResult(queryClient, await flashcardApi.prune(orphans));
      toast('Forgot the review data of deleted cards');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="fc-stats">
      <div className="fc-tiles">
        <Tile label="Answered today" value={String(stats.today.answers)} detail={`${minutes(stats.today.ms)}${stats.today.answers ? ` · ${Math.round((stats.today.again / stats.today.answers) * 100)}% again` : ''}`} />
        <Tile label="Day streak" value={String(stats.streak)} detail={stats.streak ? 'days in a row' : 'study today to start one'} />
        <Tile label="Retention" value={pct(stats.retention.all)} detail={stats.retention.count ? `${stats.retention.count} reviews, 30 days` : 'no reviews yet'} />
        <Tile label="Cards" value={String(stats.cards.total)} detail={`${stats.cards.new} new`} />
      </div>
      <div className="status-grid">
        <BarChart title="Answers per day" bars={history} empty="No answers in the last 30 days" />
        <BarChart title="Due in the next 30 days" bars={forecast} empty="Nothing scheduled yet" />
        <section className="status-card">
          <h2 className="status-card-title">Cards</h2>
          <dl className="about-list">
            <div className="about-row">
              <dt>New</dt>
              <dd>{stats.cards.new}</dd>
            </div>
            <div className="about-row">
              <dt>Learning</dt>
              <dd>{stats.cards.learning}</dd>
            </div>
            <div className="about-row">
              <dt>Young</dt>
              <dd>{stats.cards.young} <span className="muted">(interval under 21 days)</span></dd>
            </div>
            <div className="about-row">
              <dt>Mature</dt>
              <dd>{stats.cards.mature}</dd>
            </div>
            <div className="about-row">
              <dt>Retention</dt>
              <dd>
                young {pct(stats.retention.young)} · mature {pct(stats.retention.mature)}
              </dd>
            </div>
            <div className="about-row">
              <dt>All time</dt>
              <dd>
                {stats.totalAnswers} answers · {minutes(stats.totalMs)}
              </dd>
            </div>
          </dl>
          {orphans.length > 0 && (
            <div className="status-card-actions">
              <span className="muted">{orphans.length} records of deleted cards</span>
              <button type="button" className="button button-small" onClick={() => void forget()}>
                Forget them
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
